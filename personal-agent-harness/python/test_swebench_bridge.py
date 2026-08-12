from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import pyarrow as arrow
import pyarrow.parquet as parquet

from python.swebench_bridge import BridgeError, handle_request


def row(instance_id: str = "owner__repo-1") -> dict[str, str]:
    return {
        "instance_id": instance_id,
        "repo": "owner/repo",
        "base_commit": "1" * 40,
        "problem_statement": "Fix the bug",
        "version": "1.0",
        "environment_setup_commit": "2" * 40,
        "patch": "SECRET GOLD PATCH",
        "test_patch": "SECRET TEST PATCH",
        "FAIL_TO_PASS": "SECRET TESTS",
        "PASS_TO_PASS": "SECRET REGRESSIONS",
        "hints_text": "SECRET HINT",
    }


class SweBenchBridgeTest(unittest.TestCase):
    def write_rows(self, rows: list[dict[str, str]]) -> Path:
        directory = Path(tempfile.mkdtemp(prefix="swebench-bridge-"))
        path = directory / "cases.parquet"
        parquet.write_table(arrow.Table.from_pylist(rows), path)
        self.addCleanup(directory.rmdir)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return path

    def test_inspect_and_load_whitelisted_fields(self) -> None:
        path = self.write_rows([row()])
        inspected = handle_request({"operation": "inspect", "parquetPath": str(path)})
        self.assertEqual(inspected["rowCount"], 1)
        self.assertNotIn("patch", inspected["columns"])
        loaded = handle_request(
            {"operation": "load_cases", "parquetPath": str(path), "instanceIds": ["owner__repo-1"]}
        )
        case = loaded["cases"][0]
        self.assertEqual(case["problemStatement"], "Fix the bug")
        self.assertEqual(
            set(case),
            {"instanceId", "repo", "baseCommit", "problemStatement", "version", "environmentSetupCommit"},
        )

    def test_rejects_missing_columns(self) -> None:
        path = self.write_rows([{"instance_id": "owner__repo-1"}])
        with self.assertRaisesRegex(BridgeError, "Missing required columns"):
            handle_request({"operation": "inspect", "parquetPath": str(path)})

    def test_rejects_duplicate_and_unknown_instances(self) -> None:
        duplicate = self.write_rows([row(), row()])
        with self.assertRaisesRegex(BridgeError, "Duplicate instance IDs"):
            handle_request({"operation": "inspect", "parquetPath": str(duplicate)})

        path = self.write_rows([row()])
        with self.assertRaisesRegex(BridgeError, "Unknown instance IDs"):
            handle_request(
                {"operation": "load_cases", "parquetPath": str(path), "instanceIds": ["missing__repo-1"]}
            )


if __name__ == "__main__":
    unittest.main()
