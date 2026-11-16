"""Pure helpers: canonical JSON, idempotency keys, decimals, order states. No I/O."""

from __future__ import annotations

import json
import math
import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any

from .errors import ConfigurationError

# ------------------------------------------------------------------------------------------------------------ canonical JSON


def canonical_json(value: Any) -> str:
    """Deterministic JSON: object keys sorted, no whitespace, non-ASCII kept as is — byte for byte what the server's
    `canonicalJson` (services/api/src/trading-api/key-model.ts) gives for the same value, so the bytes of a call are the
    same on every retry and the server's request hash is the same too. `None` members of an object are kept (JSON null):
    drop them before calling. Floats are refused: money is a decimal string, never a binary float."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ConfigurationError("a request body cannot contain NaN or Infinity")
        raise ConfigurationError("a request body cannot contain a float: pass a decimal string (or a Decimal, or an int)")
    if isinstance(value, Decimal):
        raise ConfigurationError("a Decimal must be converted with decimal_str() before it is serialized")
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise ConfigurationError("object keys must be strings")
        # JavaScript sorts keys by UTF-16 code units
        return "{" + ",".join(f"{_js_string(k)}:{canonical_json(value[k])}" for k in sorted(value, key=_utf16_key)) + "}"
    raise ConfigurationError(f"a request body cannot contain a {type(value).__name__}")


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def _js_string(s: str) -> str:
    # JSON.stringify: non-ASCII is not escaped; lone surrogates are (well-formed JSON.stringify)
    out = json.dumps(s, ensure_ascii=False)
    return re.sub(r"[\ud800-\udfff]", lambda m: f"\\u{ord(m.group()):04x}", out)


# ------------------------------------------------------------------------------------------------------------ idempotency keys

#: what the server accepts in `Idempotency-Key`
IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,100}$")


def new_idempotency_key() -> str:
    """A fresh UUIDv4 — one per LOGICAL call. Store it before sending if the process may crash, and pass it again
    (`idempotency_key=`) to resume."""
    return str(uuid.uuid4())


# ------------------------------------------------------------------------------------------------------------ decimals

#: Money, prices and sizes are decimal STRINGS on the wire: never a binary float.
DECIMAL_RE = re.compile(r"^\d+(\.\d+)?$")


def to_decimal(value: str | int | Decimal | None) -> Decimal | None:
    """A decimal string of the API → `Decimal` (None stays None). A float is refused: it has already lost the value."""
    if value is None:
        return None
    if isinstance(value, (bool, float)):
        raise ConfigurationError("to_decimal: pass the decimal string of the API (or an int / Decimal), not a float")
    if isinstance(value, Decimal):
        return value
    try:
        d = Decimal(value)
    except (InvalidOperation, ValueError, TypeError) as e:
        raise ConfigurationError(f"to_decimal: {value!r} is not a decimal number") from e
    if not d.is_finite():
        raise ConfigurationError(f"to_decimal: {value!r} is not a finite decimal number")
    return d


def decimal_str(value: str | int | Decimal, what: str = "value") -> str:
    """A non-negative amount as the API wants it: a plain decimal string ("0.01", never "1E-2"). Accepts a decimal string,
    an int or a Decimal; a float is refused."""
    if isinstance(value, (bool, float)):
        raise ConfigurationError(f"{what}: pass a decimal string, a Decimal or an int — not a float")
    if isinstance(value, int):
        s = str(value)
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise ConfigurationError(f"{what}: not a finite number")
        s = format(value, "f")
    elif isinstance(value, str):
        s = value
    else:
        raise ConfigurationError(f"{what}: pass a decimal string, a Decimal or an int")
    if not DECIMAL_RE.match(s):
        raise ConfigurationError(f'{what}: expected a non-negative decimal such as "0.01", got {s!r}')
    return s


def size_from_notional(notional: str | int | Decimal, price: str | int | Decimal, lot_size: str | int | Decimal = "0.000001") -> str:
    """Largest multiple of `lot_size` whose value at `price` does not exceed `notional` — exact decimal arithmetic,
    rounded DOWN, never up. Example: size_from_notional("100", "64907", "0.00001") == "0.00154"."""
    (a, sa), (b, sb), (c, sc) = (_scaled(decimal_str(v, w)) for v, w in ((notional, "notional"), (price, "price"), (lot_size, "lot_size")))
    if b == 0 or c == 0:
        raise ConfigurationError("price and lot_size must be positive")
    # units = floor(notional / (price × lot)); every operand is an integer scaled by a power of ten: no rounding anywhere
    units = (a * 10 ** (sb + sc)) // (b * c * 10**sa)
    digits = str(units * c).rjust(sc + 1, "0")
    s = f"{digits[: len(digits) - sc]}.{digits[len(digits) - sc :]}" if sc else digits
    return s.rstrip("0").rstrip(".") if "." in s else s


def _scaled(s: str) -> tuple[int, int]:
    """"12.340" → (12340, 3)"""
    whole, _, frac = s.partition(".")
    return int(whole + frac), len(frac)


# ------------------------------------------------------------------------------------------------------------ order states

#: the states of the unified order state machine
ORDER_STATES: tuple[str, ...] = (
    "CREATED", "VALIDATED", "AWAITING_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED",
    "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "FAILED", "UNKNOWN",
)  # fmt: skip
#: final states. UNKNOWN is NOT final and is NOT a failure: the venue's answer is not known yet — keep reading the order.
TERMINAL_ORDER_STATES: frozenset[str] = frozenset({"FILLED", "CANCELLED", "REJECTED", "FAILED"})


def order_state(status: Any) -> str | None:
    """`status` of an order as one of ORDER_STATES (case-insensitive, `canceled` = `cancelled`), or None."""
    if not isinstance(status, str):
        return None
    s = status.upper()
    if s == "CANCELED":
        s = "CANCELLED"
    return s if s in ORDER_STATES else None


def is_terminal_order(order: Any) -> bool:
    """True when the order is final. An order whose `status` is one of the twelve states is judged by that state alone;
    for the statuses the read side still reports from older tables (`open`, `pending`, `triggered`, swap states…), the
    server's own `final` flag decides. `UNKNOWN` is never final."""
    get = order.get if isinstance(order, dict) else lambda k: getattr(order, k, None)
    s = order_state(get("status"))
    if s is not None:
        return s in TERMINAL_ORDER_STATES
    return get("final") is True
