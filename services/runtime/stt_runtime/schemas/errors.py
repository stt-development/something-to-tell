from typing import Literal

from pydantic import BaseModel, ConfigDict


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: ErrorDetail


class ValidationErrorItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str
    message: str
    type: str


class ValidationErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: list[ValidationErrorItem]
    error: Literal["validation_error"] = "validation_error"
