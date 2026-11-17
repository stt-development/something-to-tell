from pydantic import BaseModel, ConfigDict, Field


class ProjectFolderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    name: str | None = Field(default=None, min_length=1)


class ProjectFolderResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    project_id: str
    name: str
    description: str
    format_version: int


class ProjectFolderErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str
    missing: list[str] = Field(default_factory=list)
