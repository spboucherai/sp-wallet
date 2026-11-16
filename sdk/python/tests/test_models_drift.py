"""The models follow docs/openapi/trading-v1.json.

1. The committed generated files are what the generators give (models.py from the document, _client.py from the async source).
2. Independently of the generator, every schema of the document is WALKED against the model classes: each property is a
   field with that alias, required ⇔ required, the type is the same kind, enums and request constraints are the same.
   A schema change that is not followed by the models fails here.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Union, get_args, get_origin

import pytest
from pydantic.fields import FieldInfo

from conftest import OPENAPI, ROOT
from sp_wallet import models
from sp_wallet._models_base import ApiModel, RequestModel

SDK = ROOT / "sdk" / "python"


def _load(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, SDK / "scripts" / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_models_py_is_what_the_generator_gives_for_the_committed_document() -> None:
    gen = _load("gen_models")
    assert (SDK / "src/sp_wallet/models.py").read_text() == gen.generate(OPENAPI), "run: uv run python scripts/gen_models.py"


def test_the_sync_client_is_generated_from_the_async_client() -> None:
    gen = _load("gen_sync")
    assert (SDK / "src/sp_wallet/_client.py").read_text() == gen.generate((SDK / "src/sp_wallet/_async_client.py").read_text()), "run: uv run python scripts/gen_sync.py"


def test_the_generator_refuses_what_it_does_not_understand() -> None:
    gen = _load("gen_models")
    g = gen.Generator()
    with pytest.raises(ValueError, match="unsupported JSON Schema keyword"):
        g.type_of({"type": "string", "oneOf": []}, "X", False)
    with pytest.raises(ValueError, match="unsupported type"):
        g.type_of({"type": "tuple"}, "X", False)
    with pytest.raises(ValueError, match=r"unsupported \$ref"):
        g.type_of({"$ref": "https://elsewhere.example/schema.json"}, "X", False)
    with pytest.raises(ValueError, match=r"unsupported \$ref"):
        g.type_of({"$ref": "#/components/schemas/Nope"}, "X", False)
    assert g.type_of({"const": True}, "X", False) == "Literal[True]"
    assert g.type_of({"type": "string", "const": "perpetual"}, "X", False) == "Literal['perpetual']"
    assert g.type_of({"const": None}, "X", False) == "Literal[None]"
    assert g.type_of({"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {"anyOf": [{"type": "number"}, {"type": "string"}]}}, "X", False) == "dict[str, Decimal | str]"
    assert g.type_of({"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}}, "X", False) == "dict[str, Any]"
    assert g.type_of({"type": "integer", "exclusiveMinimum": 0}, "X", True) == "Annotated[int, Field(gt=0)]"
    assert g.type_of({"type": ["number", "null"]}, "X", False) == "Decimal | None"
    assert g.type_of({"type": "array", "prefixItems": [{"type": "string"}, {"type": "string"}], "items": False}, "X", False) == "tuple[str, str]"


# ------------------------------------------------------------------------------------------------------------ the walk
def _strip(ann: Any) -> tuple[Any, list[Any]]:
    """Annotated[T, …] → (T, metadata)"""
    if get_origin(ann) is Annotated:
        base, *meta = get_args(ann)
        inner, more = _strip(base)
        return inner, [*meta, *more]
    return ann, []


def _members(ann: Any) -> list[Any]:
    """The members of a union, each with its own Annotated metadata kept."""
    bare, _ = _strip(ann)
    if get_origin(bare) in (Union, types.UnionType):
        return [x for a in get_args(bare) for x in _members(a)]
    return [ann]


def _constraints(meta: list[Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for m in meta:
        for item in m.metadata if isinstance(m, FieldInfo) else [m]:
            for attr, key in (("pattern", "pattern"), ("min_length", "min"), ("max_length", "max"), ("ge", "ge"), ("le", "le"), ("gt", "gt"), ("lt", "lt")):
                if getattr(item, attr, None) is not None:
                    out[key] = getattr(item, attr)
    return out


def check(schema: Any, ann: Any, where: str, request: bool, problems: list[str]) -> None:
    """One schema against one annotation (recursively)."""
    if schema is True or schema == {}:
        if ann is not Any:
            problems.append(f"{where}: the document allows anything, the model says {ann}")
        return
    kinds: list[dict[str, Any]] = schema["anyOf"] if "anyOf" in schema else [{**schema, "type": t} for t in schema["type"]] if isinstance(schema.get("type"), list) else [schema]
    # `$ref` names a component of the document: the walk goes through it (its own `description` aside)
    kinds = [OPENAPI["components"]["schemas"][k["$ref"].rsplit("/", 1)[1]] if "$ref" in k else k for k in kinds]
    members = _members(ann)
    non_null = [m for m in members if m is not type(None)]
    wants_null = any(k.get("type") == "null" for k in kinds)
    if wants_null != (type(None) in members) and not where.endswith("?"):
        problems.append(f"{where}: nullable in the document = {wants_null}, in the model = {type(None) in members}")
    kinds = [k for k in kinds if k.get("type") != "null"]
    if not kinds and not non_null:
        return  # the document says `null` and nothing else (a member that is always null), and so does the model
    if len(kinds) != 1 or len(non_null) != 1:
        problems.append(f"{where}: unions other than `T | null` are not expected ({kinds} vs {members})")
        return
    s, raw = kinds[0], non_null[0]
    t, meta = _strip(raw)
    cons = _constraints(meta) if request else {}
    if "const" in s:
        if get_origin(t) is not Literal or list(get_args(t)) != [s["const"]] or type(get_args(t)[0]) is not type(s["const"]):
            problems.append(f"{where}: const {s['const']!r} vs {t}")
        return
    if "enum" in s:
        if get_origin(t) is not Literal or list(get_args(t)) != s["enum"]:
            problems.append(f"{where}: enum {s['enum']} vs {t}")
        return
    kind = s.get("type")
    if kind is None:
        if t is not Any:
            problems.append(f"{where}: untyped in the document, {t} in the model")
    elif kind in ("string", "integer", "number", "boolean"):
        want = {"string": str, "integer": int, "number": Decimal, "boolean": bool}[kind]
        if t is not want:
            problems.append(f"{where}: {kind} in the document, {t} in the model (a JSON number must be Decimal, never float)")
        if request:
            doc = {k: s[j] for j, k in (("pattern", "pattern"), ("minLength", "min"), ("maxLength", "max"), ("minimum", "ge"), ("maximum", "le"), ("exclusiveMinimum", "gt"), ("exclusiveMaximum", "lt")) if j in s}
            if doc != cons:
                problems.append(f"{where}: constraints {doc} in the document, {cons} in the model")
    elif kind == "array":
        if "prefixItems" in s:
            if get_origin(t) is not tuple or len(get_args(t)) != len(s["prefixItems"]) or s.get("items") is not False:
                problems.append(f"{where}: tuple {s['prefixItems']} vs {t}")
                return
            for i, (ps, pa) in enumerate(zip(s["prefixItems"], get_args(t), strict=True)):
                check(ps, pa, f"{where}[{i}]", request, problems)
            return
        if get_origin(t) is not list:
            problems.append(f"{where}: array in the document, {t} in the model")
            return
        if request and {k: s[j] for j, k in (("minItems", "min"), ("maxItems", "max")) if j in s} != cons:
            problems.append(f"{where}: array bounds differ ({s} vs {cons})")
        check(s.get("items", True), get_args(t)[0], f"{where}[]", request, problems)
    elif kind == "object":
        if not s.get("properties"):
            if get_origin(t) is not dict:
                problems.append(f"{where}: free-form object in the document, {t} in the model")
            return
        if not (isinstance(t, type) and issubclass(t, RequestModel if request else ApiModel)):
            problems.append(f"{where}: object in the document, {t} in the model")
            return
        check_model(s, t, where, request, problems)
    else:
        problems.append(f"{where}: unknown type {kind}")


def check_model(schema: dict[str, Any], model: Any, where: str, request: bool, problems: list[str]) -> None:
    props, required = schema["properties"], set(schema.get("required", []))
    by_alias = {(f.alias or name): (name, f) for name, f in model.model_fields.items()}
    if set(by_alias) != set(props):
        problems.append(f"{where} ({model.__name__}): members {sorted(set(props) ^ set(by_alias))} differ between the document and the model")
    if request and model.model_config.get("extra") != "forbid":
        problems.append(f"{where}: a request model must forbid unknown members")
    if not request and model.model_config.get("extra") != "allow":
        problems.append(f"{where}: an answer model must keep unknown members")
    for prop, ps in props.items():
        if prop not in by_alias:
            continue
        _name, f = by_alias[prop]
        if (prop in required) != f.is_required():
            problems.append(f"{where}.{prop}: required in the document = {prop in required}, in the model = {f.is_required()}")
        ann = f.annotation
        if f.metadata:
            ann = Annotated[(ann, *f.metadata)]
        # an optional member is `T | None = None` in the model: its None is not the document's null
        check(ps, ann, f"{where}.{prop}{'' if prop in required else '?'}", request, problems)


def _operations() -> list[tuple[str, dict[str, Any]]]:
    return [(o["operationId"], o) for item in OPENAPI["paths"].values() for o in item.values()]


def test_every_schema_of_the_document_matches_its_model() -> None:
    problems: list[str] = []
    seen_resp, seen_req = set(), set()
    for op_id, o in _operations():
        ok = o["responses"].get("200", {}).get("content", {}).get("application/json")
        if ok and "anyOf" in ok["schema"]:  # an answer with several shapes: each alternative against its own model, in order
            seen_resp.add(op_id)
            alts = get_args(models.RESPONSE_MODELS[op_id])
            assert len(alts) == len(ok["schema"]["anyOf"]), op_id
            for i, (alt, cls) in enumerate(zip(ok["schema"]["anyOf"], alts, strict=True)):
                check_model(alt, cls, f"{op_id}[{i}]", False, problems)
        elif ok:
            seen_resp.add(op_id)
            check_model(ok["schema"], models.RESPONSE_MODELS[op_id], op_id, False, problems)
        body = o.get("requestBody", {}).get("content", {}).get("application/json")
        if body:
            seen_req.add(op_id)
            check_model(body["schema"], models.REQUEST_MODELS[op_id], f"{op_id} (body)", True, problems)
    assert not problems, "\n".join(problems)
    assert seen_resp == set(models.RESPONSE_MODELS)
    assert seen_req == set(models.REQUEST_MODELS)
    assert len(seen_resp) == 41  # every operation has a success schema
    assert len(seen_req) == 15  # cancelOrder has no body
    # the components are walked too, and are the classes the answers use
    comp: list[str] = []
    for name, cls in (("Order", models.Order), ("CanonicalOrder", models.CanonicalOrder), ("RiskCheck", models.RiskCheck), ("Switch", models.Switch), ("Error", models.ApiErrorBody)):
        check_model(OPENAPI["components"]["schemas"][name], cls, name, False, comp)
    assert not comp, "\n".join(comp)
    assert set(OPENAPI["components"]["schemas"]) == {"Order", "CanonicalOrder", "RiskCheck", "Switch", "Error"}
    assert get_args(models.CommandResult) == (models.CommandQuery, models.CommandControl, models.CommandDryRun, models.CommandExecuted)
    assert models.CommandDryRun.model_fields["order"].annotation is models.CanonicalOrder
    assert models.CommandExecuted.model_fields["order"].annotation is models.Order
    assert models.PlacedOrder.model_fields["order"].annotation is models.Order
    assert models.StopRequest is not models.KillSwitchRequest  # the same shape, two operations, two names


def test_the_walk_detects_drift() -> None:
    """The check above is not vacuous: each of these changes to the document is reported."""
    op = OPENAPI["paths"]["/api/v1/trading/orders"]["post"]
    base = op["requestBody"]["content"]["application/json"]["schema"]
    market = OPENAPI["paths"]["/api/v1/trading/markets"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]

    def drift(schema: dict[str, Any], model: Any, request: bool, change: Any) -> list[str]:
        s = json.loads(json.dumps(schema))
        change(s)
        problems: list[str] = []
        check_model(s, model, "x", request, problems)
        return problems

    assert drift(base, models.OrderRequest, True, lambda s: None) == []
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"].update(postOnly={"type": "boolean"}))  # new member
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"].pop("tif"))  # removed member
    assert drift(base, models.OrderRequest, True, lambda s: s["required"].remove("side"))  # required → optional
    assert drift(base, models.OrderRequest, True, lambda s: s["required"].append("size"))  # optional → required
    order = OPENAPI["components"]["schemas"]["Order"]
    assert drift(order, models.Order, False, lambda s: None) == []
    assert drift(order, models.Order, False, lambda s: s["properties"]["status"]["enum"].append("EXPIRED"))  # a thirteenth state
    assert drift(order, models.Order, False, lambda s: s["properties"]["final"].update(type=["boolean", "null"]))
    placed = op["responses"]["200"]["content"]["application/json"]["schema"]
    assert drift(placed, models.PlacedOrder, False, lambda s: None) == []
    assert drift(placed, models.PlacedOrder, False, lambda s: s["properties"].update(order={"$ref": "#/components/schemas/RiskCheck"}))  # another component
    detail = OPENAPI["paths"]["/api/v1/trading/markets/{symbol}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert drift(detail, models.MarketDetail, False, lambda s: None) == []
    assert drift(detail, models.MarketDetail, False, lambda s: s["properties"]["instrument"]["anyOf"][0]["properties"]["kind"].update(const="spot"))  # const
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"]["side"]["enum"].append("short"))  # enum value
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"]["size"].update(pattern="^\\d+$"))  # constraint
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"]["slippageBps"].update(maximum=1000))
    assert drift(base, models.OrderRequest, True, lambda s: s["properties"]["size"].update(type="number"))  # type
    assert drift(market, models.MarketList, False, lambda s: None) == []
    assert drift(market, models.MarketList, False, lambda s: s["properties"]["markets"]["items"]["properties"]["mark"].update(anyOf=[{"type": "number"}, {"type": "null"}]))
    assert drift(market, models.MarketList, False, lambda s: s["properties"]["markets"]["items"]["properties"].update(fundingRate={"type": "string"}))
    assert drift(market, models.MarketList, False, lambda s: s["properties"]["total"].update(type="string"))
    assert drift(market, models.MarketList, False, lambda s: s["properties"]["markets"]["items"]["required"].remove("stale"))


def test_constants_follow_the_document() -> None:
    assert OPENAPI["info"]["version"] == models.API_VERSION
    assert list(models.SCOPES) == [s["scope"] for s in OPENAPI["x-spw-scopes"]]
    assert list(models.EXECUTION_SCOPES) == [s["scope"] for s in OPENAPI["x-spw-scopes"] if s["execution"]]
    assert list(models.WEBHOOK_EVENTS) == [e["event"] for e in OPENAPI["x-spw-webhook-events"]]
    ops = dict(_operations())
    assert set(models.OPERATIONS) == set(ops)
    assert len(ops) == 41
    assert all(o[3] for o in models.OPERATIONS.values())  # every operation is implemented
    assert sorted(k for k, o in models.OPERATIONS.items() if o[5]) == ["closePosition", "placeOrder", "reducePosition"]  # a mandate on the KEY
    assert list(models.EXECUTION_SCOPES) == ["orders:execute", "orders:cancel", "positions:manage"]
    assert list(models.ORDER_STATES) == [x["state"] for x in OPENAPI["x-spw-order-states"]]
    assert list(models.FINAL_ORDER_STATES) == [x["state"] for x in OPENAPI["x-spw-order-states"] if x["final"]] == ["FILLED", "CANCELLED", "REJECTED", "FAILED"]
    assert list(models.MANDATE_DENY_REASONS) == OPENAPI["x-spw-mandate-deny-reasons"]
    assert list(models.RISK_CHECK_IDS) == OPENAPI["x-spw-risk-checks"]
    assert list(get_args(models.Order.model_fields["status"].annotation)) == list(models.ORDER_STATES)
    for op_id, o in ops.items():
        assert list(models.OPERATION_ERRORS[op_id]) == [(e["status"], e["code"]) for e in o["x-spw-errors"]]
    for op_id, (method, path, scope, implemented, idempotent, mandate) in models.OPERATIONS.items():
        o = ops[op_id]
        assert OPENAPI["paths"][path][method.lower()]["operationId"] == op_id
        assert (scope, implemented, mandate) == (o["x-spw-scope"], o["x-spw-implemented"], o.get("x-spw-requires-mandate", False))
        assert idempotent == any(p["name"] == "Idempotency-Key" and p["required"] for p in o["parameters"])


def test_the_query_parameters_of_each_read_are_the_methods_keyword_arguments() -> None:
    import inspect

    from sp_wallet import AsyncSPWallet, SPWallet
    from test_client import CASES

    for op_id, o in _operations():
        query = {p["name"] for p in o["parameters"] if p["in"] == "query"}
        if not query:
            continue
        for cls in (SPWallet, AsyncSPWallet):
            params = set(inspect.signature(getattr(cls, CASES[op_id][0])).parameters) - {"self", "symbol", "market_id", "slug", "agent_id"}
            camel = {p.split("_")[0] + "".join(w.title() for w in p.split("_")[1:]) for p in params}
            assert camel == query, (op_id, cls.__name__)  # `open` is declared on the order list only


def test_python_sources_exist() -> None:
    assert Path(SDK / "src/sp_wallet/py.typed").exists()
