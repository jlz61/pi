#!/usr/bin/env python3
"""Minimal JSON bridge for reading local SWE-bench Parquet files."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pyarrow.parquet as parquet


BRIDGE_VERSION = "1"
REQUIRED_COLUMNS = (
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "version",
)
OPTIONAL_COLUMNS = ("environment_setup_commit",)


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _parquet_path(value: object) -> Path:
    if not isinstance(value, str) or not value:
        raise BridgeError("INVALID_REQUEST", "parquetPath must be a non-empty string")
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise BridgeError("DATASET_NOT_FOUND", f"Parquet file does not exist: {path}")
    return path


def _metadata(path: Path) -> tuple[parquet.ParquetFile, list[str]]:
    try:
        source = parquet.ParquetFile(path)
    except Exception as error:
        raise BridgeError("PARQUET_ERROR", f"Cannot read Parquet metadata: {error}") from error
    columns = source.schema_arrow.names
    missing = [name for name in REQUIRED_COLUMNS if name not in columns]
    if missing:
        raise BridgeError("INVALID_SCHEMA", f"Missing required columns: {', '.join(missing)}")
    return source, columns


def inspect_dataset(path: Path) -> dict[str, Any]:
    source, columns = _metadata(path)
    table = source.read(columns=["instance_id"])
    instance_ids = table.column("instance_id").to_pylist()
    if any(not isinstance(value, str) or not value for value in instance_ids):
        raise BridgeError("INVALID_SCHEMA", "instance_id values must be non-empty strings")
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in instance_ids:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    if duplicates:
        raise BridgeError("DUPLICATE_INSTANCE", f"Duplicate instance IDs: {', '.join(sorted(duplicates))}")
    return {
        "bridgeVersion": BRIDGE_VERSION,
        "rowCount": source.metadata.num_rows,
        "columns": [*REQUIRED_COLUMNS, *[name for name in OPTIONAL_COLUMNS if name in columns]],
        "instanceIds": instance_ids,
    }


def load_cases(path: Path, requested_ids: object) -> dict[str, Any]:
    if (
        not isinstance(requested_ids, list)
        or not requested_ids
        or any(not isinstance(value, str) or not value for value in requested_ids)
    ):
        raise BridgeError("INVALID_REQUEST", "instanceIds must be a non-empty string array")
    if len(set(requested_ids)) != len(requested_ids):
        raise BridgeError("INVALID_REQUEST", "instanceIds must not contain duplicates")

    source, columns = _metadata(path)
    selected_columns = [*REQUIRED_COLUMNS, *[name for name in OPTIONAL_COLUMNS if name in columns]]
    rows = source.read(columns=selected_columns).to_pylist()
    by_id: dict[str, dict[str, Any]] = {}
    duplicates: set[str] = set()
    for row in rows:
        instance_id = row["instance_id"]
        if not isinstance(instance_id, str) or not instance_id:
            raise BridgeError("INVALID_SCHEMA", "instance_id values must be non-empty strings")
        if instance_id in by_id:
            duplicates.add(instance_id)
        by_id[instance_id] = row
    if duplicates:
        raise BridgeError("DUPLICATE_INSTANCE", f"Duplicate instance IDs: {', '.join(sorted(duplicates))}")

    missing = [instance_id for instance_id in requested_ids if instance_id not in by_id]
    if missing:
        raise BridgeError("INSTANCE_NOT_FOUND", f"Unknown instance IDs: {', '.join(missing)}")

    cases: list[dict[str, Any]] = []
    for instance_id in requested_ids:
        row = by_id[instance_id]
        values = [row[name] for name in REQUIRED_COLUMNS]
        if any(not isinstance(value, str) for value in values):
            raise BridgeError("INVALID_SCHEMA", f"Case contains non-string required values: {instance_id}")
        case = {
            "instanceId": row["instance_id"],
            "repo": row["repo"],
            "baseCommit": row["base_commit"],
            "problemStatement": row["problem_statement"],
            "version": row["version"],
        }
        environment_commit = row.get("environment_setup_commit")
        if isinstance(environment_commit, str) and environment_commit:
            case["environmentSetupCommit"] = environment_commit
        cases.append(case)
    return {"bridgeVersion": BRIDGE_VERSION, "cases": cases}


def handle_request(request: object) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise BridgeError("INVALID_REQUEST", "Request must be a JSON object")
    operation = request.get("operation")
    path = _parquet_path(request.get("parquetPath"))
    if operation == "inspect":
        return inspect_dataset(path)
    if operation == "load_cases":
        return load_cases(path, request.get("instanceIds"))
    raise BridgeError("INVALID_REQUEST", "operation must be inspect or load_cases")


def main() -> int:
    try:
        request = json.load(sys.stdin)
        response = {"ok": True, "data": handle_request(request)}
        exit_code = 0
    except BridgeError as error:
        response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        exit_code = 1
    except Exception as error:
        response = {"ok": False, "error": {"code": "BRIDGE_ERROR", "message": str(error)}}
        exit_code = 1
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
