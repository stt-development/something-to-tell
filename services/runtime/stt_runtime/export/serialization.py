"""Deterministic, schema-validating JSON and YAML export adapters."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal, Protocol

import yaml
from pydantic import ValidationError

from ..schemas.export import EXPORT_MAX_OUTPUT_BYTES, ExportProjectionV1

ExportSerializationFormat = Literal["json", "yaml"]
ExportSerializationErrorCode = Literal[
    "export_contract_invalid",
    "export_limit_exceeded",
    "export_projection_unsafe",
]


class ExportSerializationError(ValueError):
    """Stable adapter failure that runtime routes can localize later."""

    def __init__(self, code: ExportSerializationErrorCode) -> None:
        super().__init__(code)
        self.code = code
        self.message_key = f"export.error.{code}"


class ExportSerializationAdapter(Protocol):
    """Minimal substitution boundary with no repository or filesystem surface."""

    format: ExportSerializationFormat
    media_type: str
    extension: str

    def serialize(self, projection: ExportProjectionV1) -> bytes:
        """Encode one validated projection into deterministic UTF-8 bytes."""

    def deserialize(self, payload: bytes) -> ExportProjectionV1:
        """Decode and validate one complete export document."""


def _bounded_utf8(payload: bytes) -> str:
    if len(payload) > EXPORT_MAX_OUTPUT_BYTES:
        raise ExportSerializationError("export_limit_exceeded")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ExportSerializationError("export_contract_invalid") from error


def _bounded_bytes(text: str) -> bytes:
    payload = text.encode("utf-8")
    if len(payload) > EXPORT_MAX_OUTPUT_BYTES:
        raise ExportSerializationError("export_limit_exceeded")
    return payload


def _validated_projection(value: object) -> ExportProjectionV1:
    try:
        return ExportProjectionV1.model_validate(value)
    except ValidationError as error:
        raise ExportSerializationError("export_contract_invalid") from error


class JsonExportAdapter:
    """Serialize the shared projection as stable, human-readable JSON."""

    format: Literal["json"] = "json"
    media_type = "application/json"
    extension = ".json"

    def serialize(self, projection: ExportProjectionV1) -> bytes:
        value = _validated_projection(projection)
        try:
            text = json.dumps(
                value.model_dump(mode="json"),
                ensure_ascii=False,
                allow_nan=False,
                indent=2,
                sort_keys=False,
            ) + "\n"
        except (TypeError, ValueError) as error:
            raise ExportSerializationError("export_contract_invalid") from error
        payload = _bounded_bytes(text)
        # Parsing our own bytes keeps validation symmetric with imported artifacts.
        self.deserialize(payload)
        return payload

    def deserialize(self, payload: bytes) -> ExportProjectionV1:
        text = _bounded_utf8(payload)
        try:
            value = json.loads(text, parse_constant=self._reject_non_finite)
        except (json.JSONDecodeError, ValueError) as error:
            raise ExportSerializationError("export_contract_invalid") from error
        return _validated_projection(value)

    @staticmethod
    def _reject_non_finite(value: str) -> None:
        raise ValueError(f"non-finite JSON scalar: {value}")


class _ExplicitSafeDumper(yaml.SafeDumper):
    """Safe dumper with no aliases and explicit authored-string styles."""

    def ignore_aliases(self, data: object) -> bool:
        return True

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> None:
        # PyYAML otherwise emits root-key sequences without the configured indent.
        return super().increase_indent(flow, False)


def _represent_string(dumper: _ExplicitSafeDumper, value: str) -> yaml.ScalarNode:
    # Literal blocks preserve authored line breaks; all other strings are quoted
    # so values such as dates, booleans, nulls, and numbers cannot become implicit.
    style = "|" if "\n" in value else '"'
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_ExplicitSafeDumper.add_representer(str, _represent_string)


class _NoTimestampSafeLoader(yaml.SafeLoader):
    """Safe loader variant that never constructs implicit date objects."""


_NoTimestampSafeLoader.yaml_implicit_resolvers = {
    key: [
        resolver for resolver in resolvers
        if resolver[0] != "tag:yaml.org,2002:timestamp"
    ]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class YamlExportAdapter:
    """Serialize the shared projection with a constrained YAML safe schema."""

    format: Literal["yaml"] = "yaml"
    media_type = "application/yaml"
    extension = ".yaml"

    def serialize(self, projection: ExportProjectionV1) -> bytes:
        value = _validated_projection(projection)
        try:
            text = yaml.dump(
                value.model_dump(mode="json"),
                Dumper=_ExplicitSafeDumper,
                allow_unicode=True,
                default_flow_style=False,
                explicit_start=False,
                explicit_end=False,
                indent=2,
                sort_keys=False,
                width=1_000_000,
                line_break="\n",
            )
        except yaml.YAMLError as error:
            raise ExportSerializationError("export_contract_invalid") from error
        payload = _bounded_bytes(text.rstrip("\n") + "\n")
        self.deserialize(payload)
        return payload

    def deserialize(self, payload: bytes) -> ExportProjectionV1:
        text = _bounded_utf8(payload)
        try:
            forbidden_tokens = (
                yaml.tokens.AliasToken,
                yaml.tokens.AnchorToken,
                yaml.tokens.TagToken,
            )
            if any(isinstance(token, forbidden_tokens) for token in yaml.scan(text)):
                raise ExportSerializationError("export_projection_unsafe")
            documents = list(yaml.load_all(text, Loader=_NoTimestampSafeLoader))
        except yaml.YAMLError as error:
            raise ExportSerializationError("export_projection_unsafe") from error
        if len(documents) != 1 or not isinstance(documents[0], dict):
            raise ExportSerializationError("export_contract_invalid")
        return _validated_projection(documents[0])


class ExportSerializationService:
    """Select an injected adapter without acquiring domain or persistence logic."""

    def __init__(
        self,
        adapters: Mapping[ExportSerializationFormat, ExportSerializationAdapter] | None = None,
    ) -> None:
        selected = adapters if adapters is not None else {
            "json": JsonExportAdapter(),
            "yaml": YamlExportAdapter(),
        }
        if any(key != adapter.format for key, adapter in selected.items()):
            raise ExportSerializationError("export_contract_invalid")
        self._adapters = dict(selected)

    def serialize(
        self,
        format: ExportSerializationFormat,
        projection: ExportProjectionV1,
    ) -> bytes:
        try:
            adapter = self._adapters[format]
        except KeyError as error:
            raise ExportSerializationError("export_contract_invalid") from error
        return adapter.serialize(projection)

    def deserialize(
        self,
        format: ExportSerializationFormat,
        payload: bytes,
    ) -> ExportProjectionV1:
        try:
            adapter = self._adapters[format]
        except KeyError as error:
            raise ExportSerializationError("export_contract_invalid") from error
        return adapter.deserialize(payload)
