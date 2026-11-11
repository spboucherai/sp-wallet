from __future__ import annotations

import shutil
import socket
import subprocess

import numpy as np
import pandas as pd
import pytest

from conftest import make_series
from spq.data import DataError, align, bars_per_year, interval_seconds, load_candles, load_universe, normalise
from spq.data import fetch as fetch_mod

AS_OF = "2030-01-01"


def test_interval_and_annualisation():
    assert interval_seconds("1m") == 60 and interval_seconds("4h") == 14400 and interval_seconds("1d") == 86400
    assert bars_per_year("1h") == 8760 and bars_per_year("1d") == 365 and bars_per_year("15m") == 35040
    with pytest.raises(DataError):
        interval_seconds("1x")


def test_normalise_sorts_and_keeps_closed_bars_only():
    df = make_series(10).reset_index()
    shuffled = df.sample(frac=1.0, random_state=1)
    as_of = df["ts"].iloc[-1] + pd.Timedelta(minutes=30)  # the last bar is still open at as_of
    out, q = normalise(shuffled, symbol="X", interval="1h", source="t", as_of=as_of)
    assert out.index.is_monotonic_increasing and str(out.index.tz) == "UTC"
    assert len(out) == 9 and q.unclosed_dropped == 1
    assert out.index[-1] == df["ts"].iloc[-2]
    assert list(out.columns) == ["open", "high", "low", "close", "volume"]


def test_bar_closing_exactly_at_as_of_is_closed():
    df = make_series(5).reset_index()
    out, _ = normalise(df, symbol="X", interval="1h", source="t", as_of=df["ts"].iloc[-1] + pd.Timedelta(hours=1))
    assert len(out) == 5


def test_duplicates_raise_and_identical_can_be_dropped():
    df = make_series(6).reset_index()
    dup = pd.concat([df, df.iloc[[2]]])
    with pytest.raises(DataError, match="share a timestamp"):
        normalise(dup, symbol="X", interval="1h", source="t", as_of=AS_OF)
    out, q = normalise(dup, symbol="X", interval="1h", source="t", as_of=AS_OF, on_duplicate="drop_identical")
    assert len(out) == 6 and q.duplicates_dropped == 1
    conflict = df.iloc[[2]].copy()
    conflict["close"] *= 1.01
    conflict["high"] *= 1.02
    with pytest.raises(DataError, match="conflicting"):
        normalise(pd.concat([df, conflict]), symbol="X", interval="1h", source="t", as_of=AS_OF,
                  on_duplicate="drop_identical")


def test_gaps_are_reported_not_filled():
    df = make_series(20).reset_index().drop(index=[5, 6, 7, 12])
    out, q = normalise(df, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert len(out) == 16 and q.missing_bars == 4 and q.max_gap_bars == 3 and q.expected_bars == 20
    assert [g[2] for g in q.gaps] == [3, 1]
    assert q.gaps[0][0] == "2024-01-01T05:00:00+00:00" and q.gaps[0][1] == "2024-01-01T07:00:00+00:00"
    assert not q.ok() and q.ok(max_missing_fraction=0.5)
    with pytest.raises(DataError, match="missing bars"):
        normalise(df, symbol="X", interval="1h", source="t", as_of=AS_OF, on_gap="raise")


def test_ohlc_violations_and_off_grid_fail_quality():
    df = make_series(10).reset_index()
    df.loc[3, "high"] = df.loc[3, "low"] * 0.5
    df.loc[4, "close"] = np.nan
    _, q = normalise(df, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert q.ohlc_violations == 2 and not q.ok()
    df = make_series(10).reset_index()
    df["ts"] = df["ts"] + pd.Timedelta(minutes=7)
    _, q = normalise(df, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert q.off_grid == 10 and not q.ok()


def test_epoch_and_naive_timestamps_are_utc():
    df = make_series(5).reset_index()
    expected = df.set_index("ts").index
    secs = df.assign(ts=[int(t.timestamp()) for t in df["ts"]])
    out, _ = normalise(secs, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert (out.index == expected).all() and str(out.index.tz) == "UTC"
    millis = df.assign(ts=[int(t.timestamp()) * 1000 for t in df["ts"]])
    out, _ = normalise(millis, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert (out.index == expected).all()
    naive = df.assign(ts=df["ts"].dt.tz_localize(None))
    out, _ = normalise(naive, symbol="X", interval="1h", source="t", as_of=AS_OF)
    assert (out.index == expected).all() and str(out.index.tz) == "UTC"


@pytest.mark.parametrize("ext", ["parquet", "csv"])
def test_files_roundtrip_with_range(tmp_path, ext):
    df = make_series(48)
    path = tmp_path / "coinbase" / f"ETH_1h.{ext}"
    path.parent.mkdir(parents=True)
    df.reset_index().to_parquet(path, index=False) if ext == "parquet" else df.reset_index().to_csv(path, index=False)
    out, q = load_candles("eth", "1h", "2024-01-01T10:00", "2024-01-01T20:00", root=tmp_path, as_of=AS_OF)
    assert len(out) == 10 and out.index[0] == pd.Timestamp("2024-01-01T10:00", tz="UTC")
    assert out.index[-1] == pd.Timestamp("2024-01-01T19:00", tz="UTC")  # end is exclusive
    np.testing.assert_allclose(out["close"].to_numpy(), df["close"].iloc[10:20].to_numpy())
    assert q.source == "coinbase" and q.ok()


def test_missing_origin_and_file(tmp_path, monkeypatch):
    monkeypatch.delenv("SPQ_DATA_DIR", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(DataError, match="no data origin"):
        load_candles("ETH", "1h")
    with pytest.raises(DataError, match="no candle file"):
        load_candles("ETH", "1h", root=tmp_path)


def test_universe_is_aligned_on_common_bars(tmp_path):
    a, b = make_series(30, seed=1), make_series(30, seed=2).drop(index=make_series(30).index[[4, 9]])
    for name, df in (("AAA", a), ("BBB", b)):
        p = tmp_path / "coinbase" / f"{name}_1h.parquet"
        p.parent.mkdir(exist_ok=True)
        df.reset_index().to_parquet(p, index=False)
    data, quality = load_universe(["AAA", "BBB"], "1h", root=tmp_path, as_of=AS_OF)
    assert len(data["AAA"]) == len(data["BBB"]) == 28 and data["AAA"].index.equals(data["BBB"].index)
    assert quality["BBB"].missing_bars == 2 and quality["AAA"].missing_bars == 0
    assert align({}) == {}


# ------------------------------------------------------------------------------------------------- downloader

def test_coinbase_parser_orders_and_drops_open_bar(monkeypatch, tmp_path):
    now = pd.Timestamp.now(tz="UTC").floor("h")
    ts = [int((now - pd.Timedelta(hours=k)).timestamp()) for k in range(5)]  # newest first, ts[0] still open
    rows = [[t, 9.0, 11.0, 10.0, 10.5, 3.0] for t in ts]  # [time, low, high, open, close, volume]
    calls = []

    def fake(url, params, **_):
        calls.append((url, params))
        return rows if len(calls) == 1 else []

    monkeypatch.setattr(fetch_mod, "_get_json", fake)
    monkeypatch.setattr(fetch_mod.time, "sleep", lambda *_: None)
    path, q = fetch_mod.download("ETH", "1h", now - pd.Timedelta(hours=4), source="coinbase", out=tmp_path)
    assert "ETH-USD" in calls[0][0] and calls[0][1]["granularity"] == 3600
    df, _ = load_candles("ETH", "1h", root=tmp_path)
    assert len(df) == 4 and df.index.is_monotonic_increasing  # the bar in progress is not stored
    assert df.index[-1] == now - pd.Timedelta(hours=1)
    assert df.iloc[0].to_dict() == {"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 3.0}
    # a second download merges without duplicating
    calls.clear()
    fetch_mod.download("ETH", "1h", now - pd.Timedelta(hours=4), source="coinbase", out=tmp_path)
    df2, q2 = load_candles("ETH", "1h", root=tmp_path)
    assert len(df2) == 4 and q2.duplicates_dropped == 0


def test_kraken_parser(monkeypatch, tmp_path):
    now = pd.Timestamp.now(tz="UTC").floor("h")
    ts = [int((now - pd.Timedelta(hours=k)).timestamp()) for k in range(3, -1, -1)]  # oldest first, last one open
    rows = [[t, "10.0", "11.0", "9.0", "10.5", "10.2", "3.0", 7] for t in ts]
    seen = {}

    def fake(url, params, **_):
        seen.update(params)
        return {"error": [], "result": {"XXBTZUSD": rows, "last": ts[-2]}}

    monkeypatch.setattr(fetch_mod, "_get_json", fake)
    fetch_mod.download("BTC", "1h", now - pd.Timedelta(days=1), source="kraken", out=tmp_path)
    assert seen == {"pair": "XBTUSD", "interval": 60}
    df, _ = load_candles("BTC", "1h", root=tmp_path, source="kraken")
    assert len(df) == 3 and df["high"].iloc[0] == 11.0 and df["volume"].iloc[0] == 3.0
    monkeypatch.setattr(fetch_mod, "_get_json", lambda *a, **k: {"error": ["EQuery:Unknown asset pair"]})
    with pytest.raises(DataError, match="Unknown asset pair"):
        fetch_mod.fetch_kraken("NOPE", "1h")


@pytest.mark.network
def test_live_endpoints_answer():
    cb = fetch_mod.fetch_coinbase("ETH", "1h", pd.Timestamp.now(tz="UTC") - pd.Timedelta(hours=6))
    kr = fetch_mod.fetch_kraken("ETH", "1h")
    assert len(cb) >= 5 and len(kr) >= 700


# ------------------------------------------------------------------------------------------------- PostgreSQL

@pytest.fixture(scope="module")
def pg_url(tmp_path_factory):
    initdb, pg_ctl = shutil.which("initdb"), shutil.which("pg_ctl")
    if not initdb or not pg_ctl:
        pytest.skip("PostgreSQL binaries (initdb, pg_ctl) not installed")
    base = tmp_path_factory.mktemp("pg")
    datadir = base / "d"
    subprocess.run([initdb, "-D", str(datadir), "-U", "spq", "--auth=trust", "-E", "UTF8"], check=True,
                   capture_output=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    opts = f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off"
    subprocess.run([pg_ctl, "-D", str(datadir), "-o", opts, "-l", str(base / "log"), "-w", "start"], check=True,
                   capture_output=True)
    try:
        yield f"postgresql://spq@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run([pg_ctl, "-D", str(datadir), "-m", "immediate", "stop"], capture_output=True)


def test_postgres_candles_table(pg_url):
    import psycopg

    df = make_series(30)
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(
            "CREATE TABLE candles (source text NOT NULL, symbol text NOT NULL, interval text NOT NULL, "
            "ts timestamptz NOT NULL, open numeric NOT NULL, high numeric NOT NULL, low numeric NOT NULL, "
            "close numeric NOT NULL, volume numeric NOT NULL, PRIMARY KEY (source, symbol, interval, ts))")
        rows = [("coinbase", "ETH", "1h", ts.to_pydatetime(), *map(float, r)) for ts, r in
                zip(df.index, df.to_numpy())]
        rows += [("kraken", "ETH", "1h", ts.to_pydatetime(), *map(float, r * 1.001)) for ts, r in
                 zip(df.index[:10], df.to_numpy()[:10])]
        rows += [("coinbase", "LINK", "1h", ts.to_pydatetime(), *map(float, r)) for ts, r in
                 zip(df.index[::-1], df.to_numpy()[::-1])]  # inserted newest first
        conn.cursor().executemany("INSERT INTO candles VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)

    out, q = load_candles("ETH", "1h", "2024-01-01T05:00", "2024-01-01T15:00", database_url=pg_url,
                          source="coinbase", as_of=AS_OF)
    assert len(out) == 10 and out.index[0] == pd.Timestamp("2024-01-01T05:00", tz="UTC") and q.source == "coinbase"
    np.testing.assert_allclose(out.to_numpy(), df.iloc[5:15].to_numpy(), rtol=1e-12)
    assert out.dtypes.eq("float64").all() and out.index.is_monotonic_increasing

    with pytest.raises(DataError, match="2 sources"):  # two sources and none chosen: refuse to guess
        load_candles("ETH", "1h", database_url=pg_url, as_of=AS_OF)
    one, q1 = load_candles("LINK", "1h", database_url=pg_url, as_of=AS_OF)  # a single source is unambiguous
    assert len(one) == 30 and q1.source == "coinbase" and one.index.is_monotonic_increasing
    with pytest.raises(DataError, match="no rows"):
        load_candles("ETH", "1h", "2030-01-01", database_url=pg_url, source="coinbase")
    # only closed bars leave the loader, even if the table holds a bar that is still open
    out, q = load_candles("ETH", "1h", database_url=pg_url, source="coinbase", as_of="2024-01-01T10:30")
    assert out.index[-1] == pd.Timestamp("2024-01-01T09:00", tz="UTC") and q.unclosed_dropped == 20
    # the session is read-only
    with psycopg.connect(pg_url, options="-c default_transaction_read_only=on") as conn:
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("DELETE FROM candles")
