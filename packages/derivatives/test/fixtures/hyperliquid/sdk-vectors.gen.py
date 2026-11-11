# Cross-vectors produced by the OFFICIAL Python SDK (hyperliquid-python-sdk) for action types that tests/signing_test.py does
# not cover. Key: the public test key of the SDK's own test file. Output: JSON on stdout.
import json, sys
import eth_account
import hyperliquid
from importlib.metadata import version
from eth_utils import to_hex
from hyperliquid.utils.signing import (action_hash, sign_l1_action, sign_agent, sign_usd_class_transfer_action,
    sign_withdraw_from_bridge_action, order_request_to_order_wire, order_wires_to_order_action)
from hyperliquid.utils.types import Cloid

KEY = "0x0123456789012345678901234567890123456789012345678901234567890123"
w = eth_account.Account.from_key(KEY)
VAULT = "0x1719884eb866cb12b2287399b15f7db5e7d775ea"
out = {"sdk": "hyperliquid-python-sdk " + version("hyperliquid-python-sdk"), "key": KEY, "address": w.address.lower(), "l1": [], "user": []}

def l1(name, action, vault, nonce, expires):
    for mainnet in (True, False):
        sig = sign_l1_action(w, action, vault, nonce, expires, mainnet)
        out["l1"].append({"name": name, "action": action, "vaultAddress": vault, "nonce": nonce, "expiresAfter": expires,
                          "network": "mainnet" if mainnet else "testnet", "connectionId": to_hex(action_hash(action, vault, nonce, expires)), "signature": sig})

cancel = {"type": "cancel", "cancels": [{"a": 1, "o": 82382}]}
l1("cancel by oid", cancel, None, 1700000000000, None)
l1("cancel by oid, vault", cancel, VAULT, 1700000000000, None)
l1("cancel by oid, large oid", {"type": "cancel", "cancels": [{"a": 0, "o": 601262932710}]}, None, 1794365110340, None)
cbc = {"type": "cancelByCloid", "cancels": [{"asset": 1, "cloid": Cloid.from_str("0x00000000000000000000000000000001").to_raw()}]}
l1("cancel by cloid", cbc, None, 1700000000001, None)
l1("cancel by cloid, vault", cbc, VAULT, 1700000000001, None)
lev = {"type": "updateLeverage", "asset": 1, "isCross": True, "leverage": 21}
l1("update leverage cross", lev, None, 1700000000002, None)
l1("update leverage isolated", {"type": "updateLeverage", "asset": 3, "isCross": False, "leverage": 3}, None, 1700000000003, None)
l1("update leverage, vault", lev, VAULT, 1700000000002, None)

def order(coin_asset, is_buy, sz, px, ot, ro, cloid):
    req = {"coin": "X", "is_buy": is_buy, "sz": sz, "limit_px": px, "reduce_only": ro, "order_type": ot, "cloid": Cloid.from_str(cloid) if cloid else None}
    return order_wires_to_order_action([order_request_to_order_wire(req, coin_asset)])

C = "0x1234567890abcdef1234567890abcdef"
l1("limit gtc with expiresAfter", order(1, True, 100, 100, {"limit": {"tif": "Gtc"}}, False, None), None, 1700000000004, 1700000060004)
l1("limit gtc, vault and expiresAfter", order(1, True, 100, 100, {"limit": {"tif": "Gtc"}}, False, None), VAULT, 1700000000004, 1700000060004)
l1("limit alo sell with cloid", order(0, False, 0.00123, 73699.0, {"limit": {"tif": "Alo"}}, False, C), None, 1700000000005, None)
l1("ioc reduce-only with cloid (market style)", order(4, False, 0.0147, 1670.1, {"limit": {"tif": "Ioc"}}, True, C), None, 1700000000006, None)
l1("stop market sell reduce-only", order(1, False, 0.5, 1500.5, {"trigger": {"triggerPx": 1600.0, "isMarket": True, "tpsl": "sl"}}, True, C), None, 1700000000007, None)
l1("stop limit buy", order(1, True, 0.5, 2100.0, {"trigger": {"triggerPx": 2000.0, "isMarket": False, "tpsl": "sl"}}, False, C), None, 1700000000008, None)
l1("take profit market sell reduce-only", order(1, False, 0.5, 2300.0, {"trigger": {"triggerPx": 2500.0, "isMarket": True, "tpsl": "tp"}}, True, C), None, 1700000000009, None)
l1("take profit limit sell, small price", order(7, False, 190, 0.07448, {"trigger": {"triggerPx": 0.076, "isMarket": False, "tpsl": "tp"}}, True, C), None, 1700000000010, None)
l1("noop", {"type": "noop"}, None, 1700000000011, None)

def user(name, fn, action, mainnet, types_name):
    a = dict(action)
    sig = fn(w, a, mainnet)
    out["user"].append({"name": name, "kind": types_name, "action": a, "network": "mainnet" if mainnet else "testnet", "signature": sig})

AGENT = "0x5e9ee1089755c3435139848e47e6635505d5a13a"
for mainnet in (True, False):
    user("approve agent, named", sign_agent, {"type": "approveAgent", "agentAddress": AGENT, "agentName": "spw-trade", "nonce": 1700000000100}, mainnet, "approveAgent")
    user("approve agent, unnamed", sign_agent, {"type": "approveAgent", "agentAddress": AGENT, "agentName": "", "nonce": 1700000000101}, mainnet, "approveAgent")
    user("approve agent, named with expiry", sign_agent, {"type": "approveAgent", "agentAddress": AGENT, "agentName": "spw-trade valid_until 1800000000000", "nonce": 1700000000102}, mainnet, "approveAgent")
    user("usd class transfer to perp", sign_usd_class_transfer_action, {"type": "usdClassTransfer", "amount": "12.5", "toPerp": True, "nonce": 1700000000103}, mainnet, "usdClassTransfer")
    user("usd class transfer to spot", sign_usd_class_transfer_action, {"type": "usdClassTransfer", "amount": "1", "toPerp": False, "nonce": 1700000000104}, mainnet, "usdClassTransfer")
    user("withdraw3", sign_withdraw_from_bridge_action, {"type": "withdraw3", "destination": AGENT, "amount": "12.3", "time": 1700000000105}, mainnet, "withdraw3")
json.dump(out, sys.stdout, indent=1)
