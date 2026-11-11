"""spq.data.hl_import: the API's pre-fetched bundle becomes the same local store the downloader writes, offline."""
import json

import pandas as pd
import pytest

from spq.data import DataError, load_candles
from spq.data import hl_import
from spq.data.hyperliquid import load_funding, load_meta, load_perp_universe

H = 3_600_000
T0 = 1_780_000_000_000 // H * H


def bundle(n=48, symbols=("BTC", "ETH")):
    candles, funding = {}, {}
    for k, s in enumerate(symbols):
        px = 100.0 * (k + 1)
        candles[s] = [[T0 + i * H, str(px + i), str(px + i + 2), str(px + i - 1), str(px + i + 1), "12.5"] for i in range(n)]
        funding[s] = [[T0 + i * H + 37, "0.0000125", None if i % 2 else "0.0001"] for i in range(n)]
    return {"interval": "1h", "as_of_ms": T0 + n * H - 1, "meta": {s: {"max_leverage": 40, "size_decimals": 5} for s in symbols},
            "candles": candles, "funding": funding}


def test_bundle_becomes_the_downloader_layout_and_drops_the_bar_in_progress(tmp_path):
    summary = hl_import.import_bundle(bundle(), tmp_path)
    # as_of is one millisecond before the last bar closes: that bar is in progress and is not stored
    assert summary == {"BTC": {"bars": 47, "funding": 48}, "ETH": {"bars": 47, "funding": 48}}
    df, q = load_candles("BTC", "1h", root=tmp_path, source="hyperliquid", as_of=pd.Timestamp(T0 + 48 * H, unit="ms", tz="UTC"))
    assert len(df) == 47 and q.missing_bars == 0 and df["close"].iloc[0] == 101.0
    f, fq = load_funding("BTC", root=tmp_path, as_of=pd.Timestamp(T0 + 48 * H, unit="ms", tz="UTC"))
    assert fq.n == 48 and fq.off_grid == 0 and fq.max_offset_ms == 37 and f["rate"].iloc[0] == 0.0000125
    assert load_meta(tmp_path)["universe"]["ETH"] == {"max_leverage": 40.0, "size_decimals": 5, "delisted": False}
    data, _, _, _ = load_perp_universe(["BTC", "ETH"], "1h", root=tmp_path, as_of=pd.Timestamp(T0 + 48 * H, unit="ms", tz="UTC"))
    assert list(data) == ["BTC", "ETH"] and data["ETH"]["funding"].notna().all()


def test_spot_candles_are_written_for_the_benchmark(tmp_path):
    b = bundle()
    b["spot"] = {"source": "coinbase", "candles": {"BTC": b["candles"]["BTC"], "ETH": b["candles"]["ETH"]}}
    assert hl_import.import_bundle(b, tmp_path)["BTC"]["spot_bars"] == 47
    assert (tmp_path / "coinbase" / "BTC_1h.parquet").exists()


@pytest.mark.parametrize("mutate", [
    lambda b: b["funding"].pop("ETH"),                                   # funding must cover the same symbols
    lambda b: b["candles"]["BTC"].append(b["candles"]["BTC"][3]),         # duplicated bar
    lambda b: b["funding"]["BTC"].append([T0 + 5 * H + 900, "0.5", None]),  # two settlements for one hour
    lambda b: b["candles"].__setitem__("btc", b["candles"].pop("BTC")),   # not an upper-case ticker
    lambda b: b.pop("interval"),
])
def test_a_bundle_that_is_not_clean_is_refused(tmp_path, mutate):
    b = bundle()
    mutate(b)
    with pytest.raises((DataError, ValueError)):
        hl_import.import_bundle(b, tmp_path)


def test_cli_exit_codes_and_no_network_import(tmp_path, capsys):
    path = tmp_path / "bundle.json"
    path.write_text(json.dumps(bundle()))
    assert hl_import.main(["--input", str(path), "--out", str(tmp_path / "data")]) == 0
    assert json.loads(capsys.readouterr().out)["BTC"]["bars"] == 47
    path.write_text("{}")
    assert hl_import.main(["--input", str(path), "--out", str(tmp_path / "data2")]) == 2
    # the module itself opens no connection: it has no reference to the downloader's request function
    assert not any(name in vars(hl_import) for name in ("post_info", "urllib", "fetch_candles", "fetch_funding", "download"))
