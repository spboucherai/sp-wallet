"""Generates src/sp_wallet/models.py from docs/openapi/trading-v1.json (the contract of the SP Trading API).

    uv run python scripts/gen_models.py            write the file
    uv run python scripts/gen_models.py --check    exit 1 when the committed file is not what the document gives

Only the JSON Schema subset the document uses is understood (type, properties, required, additionalProperties, items,
prefixItems, enum, const, anyOf, the validation keywords, and `$ref` to `#/components/schemas/<name>` — a named model);
anything else raises instead of guessing.
tests/test_models_drift.py regenerates and compares, and separately walks the document against the model classes.
"""

from __future__ import annotations

import json
import keyword
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
OPENAPI_PATH = HERE.parents[2] / "docs" / "openapi" / "trading-v1.json"
OUTPUT_PATH = HERE.parent / "src" / "sp_wallet" / "models.py"

KNOWN = {
    "type", "properties", "required", "additionalProperties", "items", "prefixItems", "enum", "const", "anyOf", "$ref", "propertyNames", "description",
    "default",
    "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems",
}  # fmt: skip

#: operationId -> name of the response model
RESPONSE_NAMES = {
    "getOpenApi": "OpenApiDocument", "listMarkets": "MarketList", "getMarket": "MarketDetail", "getOrderbook": "Orderbook",
    "getCandles": "Candles", "getPortfolio": "Portfolio", "getBalances": "Balances", "getActivity": "Activity",
    "listNfts": "NftList", "getNft": "NftDetail", "getNftActivity": "NftActivity", "getNftMarket": "NftMarket", "getNftMarketEvents": "NftMarketEvents",
    "listPositions": "Positions", "listOrders": "Orders", "getOrder": "OrderDetail", "listStrategies": "Strategies",
    "listAgents": "Agents", "getRisk": "Risk", "compareMarkets": "MarketComparison", "listPrivateMarkets": "PrivateMarkets",
    "getPrivateMarketCompany": "PrivateMarketCompanyDetail", "getPrivateMarket": "PrivateMarketDetail", "previewOrder": "OrderPreview",
    "placeOrder": "PlacedOrder", "closePosition": "PlacedOrder", "reducePosition": "PlacedOrder", "cancelOrder": "CancelledOrder",
    "runCommand": "CommandResult", "engageKillSwitch": "KillSwitchResult", "listAgentTemplates": "AgentTemplates", "getAgent": "AgentDetail",
    "listAgentSignals": "AgentSignals", "listAgentJournal": "AgentJournal", "listAgentOrders": "AgentOrders", "getAgentPerformance": "AgentPerformance",
    "getJob": "JobResult", "backtestStrategy": "JobResult", "backtestAgent": "JobResult", "createStrategy": "StrategyResult", "startStrategy": "AgentResult",
    "stopStrategy": "AgentResult", "createAgent": "AgentResult", "startAgent": "AgentResult", "pauseAgent": "AgentResult", "stopAgent": "AgentResult",
}  # fmt: skip
#: an answer that is one of several shapes (`anyOf` of objects): operationId -> the model name of each alternative, in the document's order
UNION_NAMES = {"runCommand": ["CommandQuery", "CommandControl", "CommandDryRun", "CommandExecuted"]}
#: name of a component schema (`#/components/schemas/<name>`) -> name of its model
COMPONENT_NAMES = {"Error": "ApiErrorBody", "Order": "Order", "CanonicalOrder": "CanonicalOrder", "RiskCheck": "RiskCheck", "Switch": "Switch"}
#: operationId -> name of the request-body model (identical schemas share one class: the first name wins)
REQUEST_NAMES = {
    "placeOrder": "OrderRequest", "previewOrder": "OrderRequest", "closePosition": "ClosePositionRequest",
    "reducePosition": "ReducePositionRequest", "createStrategy": "CreateStrategyRequest", "backtestStrategy": "BacktestRequest",
    "startStrategy": "StartRequest", "startAgent": "StartRequest", "stopStrategy": "StopRequest", "stopAgent": "StopRequest",
    "createAgent": "CreateAgentRequest", "runCommand": "CommandRequest", "engageKillSwitch": "KillSwitchRequest", "pauseAgent": "StopRequest",
    "backtestAgent": "AgentBacktestRequest",
}  # fmt: skip
#: mechanical name of a nested object (Parent + Property [+ Item]) -> the name used
NESTED_NAMES = {
    "MarketListMarketsItem": "Market", "MarketListErrorsItem": "PartialError", "CandlesCandlesItem": "Candle",
    "PortfolioWalletBalancesItem": "PortfolioBalance", "PortfolioAccountsItem": "PortfolioAccount", "BalancesBalancesItem": "Balance",
    "ActivityItemsItem": "ActivityItem", "PositionsPositionsItem": "Position",
    "NftListItemsItem": "Nft", "NftMarketSourcesItem": "NftMarketSource", "NftMarketEventsSourcesItemEventsItem": "NftMarketEvent", "NftMarketRatesValue": "NftRate", "NftActivityEventsItem": "NftEvent",
    "StrategiesLibraryItem": "StrategyLibraryEntry", "StrategiesVersionsItem": "StrategyVersion",
    "AgentsAgentsItem": "Agent", "RiskKillSwitch": "KillSwitch", "RiskCapabilityLocksItem": "CapabilityLock", "RiskAccountsItem": "RiskAccount",
    "MarketDetailInstrument": "Instrument", "MarketDetailTicker": "Ticker", "OrderDetailFillsItem": "Fill",
    "RiskEngine": "RiskEngine", "OrderPreviewRefusalsItem": "Refusal", "OrderPreviewAccount": "PreviewAccount", "OrderPreviewRisk": "PreviewRisk",
    "PlacedOrderApproval": "OwnerApproval", "ApiErrorBodyData": "ErrorData", "ApiErrorBodyDataQuestionsItem": "CommandQuestion",
    "MarketComparisonRowsItem": "ComparisonRow", "PrivateMarketsMarketsItem": "PrivateMarket", "PrivateMarketsCompaniesItem": "PrivateCompany",
}  # fmt: skip


def snake(name: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()
    s = re.sub(r"[^a-z0-9_]", "_", s)
    if not s or s[0].isdigit():
        s = f"f_{s}"
    return f"{s}_" if keyword.iskeyword(s) else s


def pascal(name: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]+", name) if p)


class Generator:
    def __init__(self, components: dict[str, Any] | None = None) -> None:
        self.classes: dict[str, str] = {}  # name -> source
        self.by_schema: dict[str, str] = {}  # canonical schema JSON (+ kind) -> name
        self.components: dict[str, Any] = components or {}
        self.component_models: dict[str, str] = {}  # component name -> model name
        self.top: dict[str, str] = {}  # name of an operation's body / answer model -> its schema key

    def component(self, name: str) -> str:
        """The model of `#/components/schemas/<name>` (an answer shape: components are never request bodies)."""
        if name not in self.component_models:
            self.component_models[name] = self.model(self.components[name], COMPONENT_NAMES[name], request=False)
        return self.component_models[name]

    def type_of(self, s: Any, hint: str, request: bool) -> str:
        if s is True or s == {}:
            return "Any"
        if not isinstance(s, dict):
            raise ValueError(f"unsupported schema: {s!r}")
        unknown = set(s) - KNOWN
        if unknown:
            raise ValueError(f"unsupported JSON Schema keyword(s) {sorted(unknown)} — extend gen_models.py")
        if "$ref" in s:
            m = re.fullmatch(r"#/components/schemas/([A-Za-z][A-Za-z0-9]*)", s["$ref"])
            if not m or m.group(1) not in self.components:
                raise ValueError(f"unsupported $ref {s['$ref']!r} — only #/components/schemas/<name> of this document")
            return self.component(m.group(1))
        if "const" in s:
            return f"Literal[{s['const']!r}]"
        if "enum" in s:
            return f"Literal[{', '.join(json.dumps(v) for v in s['enum'])}]"
        if "anyOf" in s:
            return " | ".join(self.type_of(x, hint, request) for x in s["anyOf"])
        t = s.get("type")
        if isinstance(t, list):
            return " | ".join(self.type_of({**s, "type": x}, hint, request) for x in t)
        if t is None:
            return "Any"
        if t == "null":
            return "None"
        if t == "boolean":
            return "bool"
        if t in ("string", "integer", "number"):
            base = {"string": "str", "integer": "int", "number": "Decimal"}[t]
            if not request:
                return base
            c = []
            if "pattern" in s:
                c.append(f"pattern={s['pattern']!r}")
            if "minLength" in s:
                c.append(f"min_length={s['minLength']}")
            if "maxLength" in s:
                c.append(f"max_length={s['maxLength']}")
            if "minimum" in s:
                c.append(f"ge={s['minimum']}")
            if "maximum" in s:
                c.append(f"le={s['maximum']}")
            if "exclusiveMinimum" in s:
                c.append(f"gt={s['exclusiveMinimum']}")
            if "exclusiveMaximum" in s:
                c.append(f"lt={s['exclusiveMaximum']}")
            return f"Annotated[{base}, Field({', '.join(c)})]" if c else base
        if t == "array":
            if "prefixItems" in s:
                if s.get("items") is not False:
                    raise ValueError("open tuples are not supported")
                return f"tuple[{', '.join(self.type_of(x, hint, request) for x in s['prefixItems'])}]"
            inner = f"list[{self.type_of(s.get('items', True), hint + 'Item', request)}]"
            c = []
            if request and "minItems" in s:
                c.append(f"min_length={s['minItems']}")
            if request and "maxItems" in s:
                c.append(f"max_length={s['maxItems']}")
            return f"Annotated[{inner}, Field({', '.join(c)})]" if c else inner
        if t == "object":
            if s.get("propertyNames") not in (None, {"type": "string"}):
                raise ValueError("only string property names are supported")
            if not s.get("properties"):
                ap = s.get("additionalProperties")
                # a map (zod's z.record): no named member, every value of one schema
                return f"dict[str, {self.type_of(ap, hint + 'Value', request)}]" if isinstance(ap, dict) and ap else "dict[str, Any]"
            return self.model(s, hint, request)
        raise ValueError(f"unsupported type {t!r}")

    def model(self, s: dict[str, Any], hint: str, request: bool, top: bool = False) -> str:
        """`top`: the body or the answer of an operation, generated under ITS name even when another operation has the same
        shape (StopRequest and KillSwitchRequest are both `{reason}`: two names, two classes). Nested shapes are shared."""
        key = json.dumps(s, sort_keys=True) + ("|request" if request else "|response")
        if top:
            if self.top.get(hint) == key:
                return hint
            key += f"|{hint}"
        if key in self.by_schema:
            return self.by_schema[key]
        name = NESTED_NAMES.get(hint, hint)
        if name in self.classes:
            raise ValueError(f"two different schemas want the class name {name}: add an entry to NESTED_NAMES")
        if top:
            self.top[hint] = key[: -len(hint) - 1]
        self.by_schema[key] = name
        self.classes[name] = ""  # reserve the position after its dependencies are known
        required = set(s.get("required", []))
        open_ = s.get("additionalProperties") is not False
        lines = [f"class {name}({'RequestModel' if request else 'ApiModel'}):"]
        doc = s.get("description")
        extra = "extra members are allowed by the contract" if open_ else "closed object in the contract"
        lines.append(f'    """{(doc + " — ") if doc else ""}{extra}"""')
        lines.append("")
        fields = []
        for prop, ps in s["properties"].items():
            py = snake(prop)
            ann = self.type_of(ps, name + pascal(prop), request)
            args = []
            if prop not in required:
                if ann != "Any" and "None" not in ann.split(" | "):
                    ann += " | None"
                args.append("default=None")
            if py != prop:
                args.append(f"alias={prop!r}")
            desc = ps.get("description")
            if "default" in ps:
                desc = f"{desc + ' — ' if desc else ''}server default: {json.dumps(ps['default'])}"
            if desc:
                args.append(f"description={desc!r}")
            fields.append(f"    {py}: {ann}" + (f" = Field({', '.join(args)})" if args else ""))
        lines += fields
        del self.classes[name]
        self.classes[name] = "\n".join(lines)
        return name


def generate(document: dict[str, Any]) -> str:
    g = Generator(document["components"]["schemas"])
    for component in document["components"]["schemas"]:
        g.component(component)
    ops = [(o["operationId"], method.upper(), path, o) for path, item in document["paths"].items() for method, o in item.items()]
    responses: dict[str, str] = {}
    requests: dict[str, str] = {}
    unions: dict[str, list[str]] = {}
    for op_id, _method, _path, o in ops:
        ok = o["responses"].get("200", {}).get("content", {}).get("application/json")
        if ok and "anyOf" in ok["schema"]:
            alts = [g.model(alt, name, request=False, top=True) for alt, name in zip(ok["schema"]["anyOf"], UNION_NAMES[op_id], strict=True)]
            unions[RESPONSE_NAMES[op_id]] = alts
            responses[op_id] = RESPONSE_NAMES[op_id]
        elif ok:
            responses[op_id] = g.model(ok["schema"], RESPONSE_NAMES[op_id], request=False, top=True)
        body = o.get("requestBody", {}).get("content", {}).get("application/json")
        if body:
            requests[op_id] = g.model(body["schema"], REQUEST_NAMES[op_id], request=True, top=True)

    out = [
        '"""Models of the SP Trading API.',
        "",
        "GENERATED by scripts/gen_models.py from docs/openapi/trading-v1.json — do not edit.",
        "tests/test_models_drift.py fails when this file is not what the generator gives, or when a model no longer",
        "matches the document.",
        "",
        "Money, prices and sizes are decimal STRINGS (`str`) exactly as the API sends them: use `sp_wallet.to_decimal`.",
        "The few members the API sends as JSON numbers are `Decimal` (the SDK never parses a number as a binary float).",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from decimal import Decimal",
        "from typing import Annotated, Any, Literal",
        "",
        "from pydantic import Field",
        "",
        "from ._models_base import ApiModel, RequestModel",
        "",
        f"API_VERSION = {document['info']['version']!r}",
        f"SCOPES: tuple[str, ...] = ({', '.join(repr(s['scope']) for s in document['x-spw-scopes'])},)",
        "#: inert on a key that is not bound to a trading mandate (403 `mandate_required`)",
        f"EXECUTION_SCOPES: tuple[str, ...] = ({', '.join(repr(s['scope']) for s in document['x-spw-scopes'] if s['execution'])},)",
        f"WEBHOOK_EVENTS: tuple[str, ...] = ({', '.join(repr(e['event']) for e in document['x-spw-webhook-events'])},)",
        "#: the states of the unified order state machine — the closed set of `Order.status`",
        f"ORDER_STATES: tuple[str, ...] = ({', '.join(repr(x['state']) for x in document['x-spw-order-states'])},)",
        "#: UNKNOWN is not among them: it is neither final nor a failure",
        f"FINAL_ORDER_STATES: tuple[str, ...] = ({', '.join(repr(x['state']) for x in document['x-spw-order-states'] if x['final'])},)",
        "#: `data.reasons` of a `mandate_denied` refusal",
        f"MANDATE_DENY_REASONS: tuple[str, ...] = ({', '.join(repr(x) for x in document['x-spw-mandate-deny-reasons'])},)",
        "#: ids of the risk checks (`data.failed`, `data.checks[].id`, `risk.checks[].id` of a preview)",
        f"RISK_CHECK_IDS: tuple[str, ...] = ({', '.join(repr(x) for x in document['x-spw-risk-checks'])},)",
        "",
    ]
    for src in g.classes.values():
        out += ["", src, ""]
    for name, alts in unions.items():
        out += ["", "#: one of several shapes: narrow with isinstance (or on the members `kind` and `executed`)", f"{name} = {' | '.join(alts)}", ""]
    out += ["", "#: operationId -> (method, path template, scope, implemented by the server, mutating/idempotency-keyed, needs a mandate)"]
    out.append("OPERATIONS: dict[str, tuple[str, str, str, bool, bool, bool]] = {")
    for op_id, method, path, o in ops:
        idem = any(p["in"] == "header" and p["name"] == "Idempotency-Key" and p.get("required") for p in o.get("parameters", []))
        out.append(
            f"    {op_id!r}: ({method!r}, {path!r}, {o['x-spw-scope']!r}, {o['x-spw-implemented'] is True}, {idem}, "
            f"{o.get('x-spw-requires-mandate') is True}),"
        )
    out.append("}")
    out.append("#: operationId -> every error answer the operation can give: (HTTP status, code) — the document's `x-spw-errors`")
    out.append("OPERATION_ERRORS: dict[str, tuple[tuple[int, str], ...]] = {")
    for op_id, _method, _path, o in ops:
        out.append(f"    {op_id!r}: ({', '.join(repr((e['status'], e['code'])) for e in o['x-spw-errors'])},),")
    out.append("}")
    out.append("#: operationId -> response model")
    out.append("#: (a model class, or a union of model classes for an answer that has several shapes)")
    out.append("RESPONSE_MODELS: dict[str, Any] = {" + ", ".join(f"{k!r}: {v}" for k, v in responses.items()) + "}")
    out.append("#: operationId -> request-body model")
    out.append("REQUEST_MODELS: dict[str, type[RequestModel]] = {" + ", ".join(f"{k!r}: {v}" for k, v in requests.items()) + "}")
    out.append("")
    names = sorted([
        *g.classes, *unions, "API_VERSION", "SCOPES", "EXECUTION_SCOPES", "WEBHOOK_EVENTS", "OPERATIONS", "OPERATION_ERRORS", "RESPONSE_MODELS",
        "REQUEST_MODELS",
        "ORDER_STATES", "FINAL_ORDER_STATES", "MANDATE_DENY_REASONS", "RISK_CHECK_IDS",
    ])  # fmt: skip
    out.append("__all__ = [" + ", ".join(repr(n) for n in names) + "]")
    out.append("")
    return "\n".join(out)


def main() -> int:
    text = generate(json.loads(OPENAPI_PATH.read_text()))
    if "--check" in sys.argv:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_text() != text:
            print("src/sp_wallet/models.py is out of date: run `uv run python scripts/gen_models.py`", file=sys.stderr)
            return 1
        print("src/sp_wallet/models.py is up to date")
        return 0
    OUTPUT_PATH.write_text(text)
    print(f"wrote {OUTPUT_PATH} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
