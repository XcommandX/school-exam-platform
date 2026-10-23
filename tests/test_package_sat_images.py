"""Focused offline-archive checks using synthetic images and a local HTTP server."""
import base64
import contextlib
import hashlib
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile


SPEC = importlib.util.spec_from_file_location("package_sat_images", Path(__file__).resolve().parents[1] / "scripts/package_sat_images.py")
archiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archiver)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRQAAAABJRU5ErkJggg==")


@contextlib.contextmanager
def server():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            if self.path.split("?")[0] in {"/ok.png", "/same.png", "/entity.png"}:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(PNG)
            elif self.path == "/bad.png":
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                self.wfile.write(b"<!doctype html><html>not an image</html>")
            else:
                self.send_error(404)

        def log_message(self, *_):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", calls
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


class PackageSATImagesTests(unittest.TestCase):
    def test_embedded_requires_digest_and_image_signature(self):
        candidate = {"file": "synthetic.json", "sha256": hashlib.sha256(PNG).hexdigest(),
                     "mime_type": "image/png", "data_base64": base64.b64encode(PNG).decode()}
        data, source, errors = archiver.recover_embedded([candidate])
        self.assertEqual((data, source, errors), (PNG, "synthetic.json", []))
        bad = dict(candidate, sha256="0" * 64)
        data, _, errors = archiver.recover_embedded([bad])
        self.assertIsNone(data)
        self.assertIn("SHA-256", errors[0]["error"])
        with self.assertRaises(ValueError):
            archiver.image_type(b"<html><img src='something.png'></html>")

    def test_html_css_srcset_markdown_entities_and_protocol_rejection(self):
        value = '<img src="https://example.org/a.png?a=1&amp;b=2" srcset="https://example.org/b.png 1x, https://example.org/c.png 2x"><span style="background:url(https://example.org/d.png)"></span>'
        urls = archiver.string_image_urls(value)
        self.assertTrue({"https://example.org/a.png?a=1&b=2", "https://example.org/b.png", "https://example.org/c.png", "https://example.org/d.png"}.issubset(urls))
        self.assertIn("https://example.org/e.png", archiver.string_image_urls("![plot](https://example.org/e.png)"))
        for value in ("file:///tmp/image.png", "javascript:alert(1)", "ftp://example.org/image.png"):
            with self.assertRaises(ValueError):
                archiver.request_url(value)

    def test_archive_download_recovery_dedup_failure_and_zip_closure(self):
        with tempfile.TemporaryDirectory() as temp, server() as (base, calls):
            root = Path(temp)
            folder = root / "英语"
            folder.mkdir()
            bad = base + "/bad.png"
            missing = base + "/missing.png"
            entity = base + "/entity.png?a=1&b=2"
            document = {"title": "synthetic only", "questions": [{"answer": "B", "prompt_html":
                f'<img src="{base}/ok.png"><img src="{bad}"><img src="{missing}"><img src="{entity.replace("&", "&amp;")}">',
                "choices": ["A", "B"]}], "images": [
                    {"source_url": bad, "sha256": hashlib.sha256(PNG).hexdigest(), "mime_type": "image/png", "data_base64": base64.b64encode(PNG).decode()},
                    {"source_url": missing, "sha256": "0" * 64, "data_base64": base64.b64encode(PNG).decode()},
                    {"source_url": base + "/same.png"}]}
            source_file = folder / "sample.json"
            source_bytes = json.dumps(document, ensure_ascii=False).encode()
            source_file.write_bytes(source_bytes)
            report = archiver.package(root, workers=3, retries=0)
            entries = {item["source_url"]: item for item in report["images"]}
            self.assertEqual(entries[bad]["status"], "embedded_recovered")
            self.assertEqual(entries[bad]["network"][0]["outcome"], "invalid_image")
            self.assertEqual(entries[missing]["status"], "failed")
            self.assertEqual(entries[missing]["network"][0]["http_status"], 404)
            self.assertEqual(report["summary"]["unique_local_assets"], 1)
            self.assertEqual(source_file.read_bytes(), source_bytes)
            offline = json.loads((root / "离线题包/英语/sample.json").read_text())
            self.assertEqual(offline["questions"][0]["answer"], "B")
            self.assertIn(missing, offline["questions"][0]["prompt_html"])
            self.assertNotIn(entity.replace("&", "&amp;"), offline["questions"][0]["prompt_html"])
            self.assertNotIn("data_base64", json.dumps(offline))
            self.assertFalse(report["closure_check"]["fully_offline"])
            self.assertTrue(report["closure_check"]["all_resolved_files_exist_and_hash_match"])
            with zipfile.ZipFile(root / "耕读合集-图片离线包.zip") as zipped:
                self.assertIsNone(zipped.testzip())
                self.assertIn("离线题包/英语/sample.json", zipped.namelist())
                for entry in entries.values():
                    if entry["local_path"]:
                        self.assertIn(entry["local_path"], zipped.namelist())
                        self.assertEqual(hashlib.sha256(zipped.read(entry["local_path"])).hexdigest(), entry["sha256"])
            before = len(calls)
            again = archiver.package(root, workers=2, retries=0)
            self.assertEqual(again["summary"]["source_json_packages"], 1)
            # Resolved files are reused; only the unresolved URL is requested.
            self.assertEqual(calls[before:], ["/missing.png"])
            self.assertEqual(again["summary"]["cache_reused_references"], 4)
            self.assertEqual(again["summary"]["this_run_http_get_attempts"], 1)
            # A wrong relative path must fail even if manifest assets exist.
            broken = {"sample.json": {"questions": [{"prompt_html": '<img src="../wrong.png">'}]}}
            closure = archiver.check_offline_closure(root, broken, list(entries.values()))
            self.assertFalse(closure["all_local_references_resolve_and_match_sha256"])

    def test_alternate_and_inline_svg_are_archived_without_execution(self):
        with tempfile.TemporaryDirectory() as temp, server() as (base, calls):
            root = Path(temp)
            inline = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"
            document = {"questions": [{"prompt_html": f'<img src="{inline}">'}], "images": [
                {"source_url": base + "/missing.png", "download_url": base + "/ok.png"},
                {"source_url": inline}]}
            (root / "sample.json").write_text(json.dumps(document))
            report = archiver.package(root, retries=0)
            entries = {item["source_url"]: item for item in report["images"]}
            self.assertEqual(entries[base + "/missing.png"]["status"], "downloaded_alternate")
            self.assertEqual(entries[inline]["status"], "inline_extracted")
            self.assertTrue(entries[inline]["svg_archived_without_execution"])
            self.assertTrue(report["closure_check"]["fully_offline"])
            self.assertCountEqual(calls, ["/missing.png", "/ok.png"])

    def test_source_content_change_is_reported_and_original_embedded_image_wins(self):
        with tempfile.TemporaryDirectory() as temp, server() as (base, _):
            root = Path(temp)
            original = PNG + b"original-image-source"
            document = {"questions": [{"prompt_html": f'<img src="{base}/ok.png">'}], "images": [{
                "source_url": base + "/ok.png", "sha256": hashlib.sha256(original).hexdigest(),
                "mime_type": "image/png", "data_base64": base64.b64encode(original).decode()}]}
            (root / "sample.json").write_text(json.dumps(document))
            report = archiver.package(root, retries=0)
            item = report["images"][0]
            self.assertTrue(item["source_content_changed"])
            self.assertEqual(item["downloaded_sha256"], hashlib.sha256(PNG).hexdigest())
            self.assertEqual(item["sha256"], hashlib.sha256(original).hexdigest())
            self.assertEqual(item["status"], "embedded_recovered")

    def test_unsafe_output_paths_and_source_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                archiver.safe_output(root, "../escape.png")
            outside = root / "outside"
            outside.mkdir()
            (root / "assets").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                archiver.safe_output(root, "assets/image.png")


if __name__ == "__main__":
    unittest.main()
