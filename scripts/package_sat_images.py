#!/usr/bin/env python3
"""Download and archive image references in local SAT source JSON packages.

Python 3.10+, standard library only. This is an archival tool, not a website
importer or an HTML/SVG renderer. Source JSON files are never modified.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import posixpath
import re
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import unquote_to_bytes, urlsplit, urlunsplit, quote
from urllib.request import build_opener, HTTPSHandler, HTTPRedirectHandler, Request
import xml.etree.ElementTree as ET
import zipfile


GENERATED_DIRS = {"assets", "离线题包", "offline", "__pycache__"}
GENERATED_FILES = {"图片清单.json", "下载报告.json"}
IMAGE_KEYS = {"source_url", "download_url", "image_url", "imageUrl", "src", "poster"}
CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)")
BARE_IMAGE = re.compile(r"https?://[^\s<>\"']+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg)(?:\?[^\s<>\"']*)?", re.I)
MAX_IMAGE_BYTES = 32 * 1024 * 1024


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def image_type(data: bytes) -> tuple[str, str]:
    """Check bytes rather than trusting a URL extension or HTTP Content-Type."""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        return "image/png", ".png"
    # JPEG permits application data after its end-of-image marker.
    if data.startswith(b"\xff\xd8\xff") and data.rfind(b"\xff\xd9") >= 3:
        return "image/jpeg", ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 13:
        return "image/gif", ".gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 16:
        return "image/webp", ".webp"
    if data.startswith(b"BM") and len(data) >= 26:
        return "image/bmp", ".bmp"
    if data[:4] in (b"II*\0", b"MM\0*") and len(data) >= 8:
        return "image/tiff", ".tiff"
    head = data.lstrip()[:1024].lower()
    if head.startswith((b"<svg", b"<?xml")):
        if b"<!doctype" in data.lower() or b"<!entity" in data.lower():
            raise ValueError("SVG with a DTD/entity is not archived")
        try:
            root = ET.fromstring(data)
        except ET.ParseError as exc:
            raise ValueError("Invalid SVG XML") from exc
        if root.tag.split("}")[-1] == "svg":
            return "image/svg+xml", ".svg"
    raise ValueError("Response is not a supported image (signature check failed)")


def normalize_url(value: str) -> str:
    return html.unescape(value.strip())


def request_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise ValueError("Only absolute http(s) image URLs may be requested")
    if parts.username or parts.password or any(ord(c) < 32 for c in url):
        raise ValueError("Credentials/control characters in an image URL are rejected")
    # A source can contain a broken author-local path inside an HTTPS path.
    # Request that literal server path; never interpret it as a local file.
    return urlunsplit((parts.scheme, parts.netloc, quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
                       quote(parts.query, safe="%=&?/:@!$'()*+,;~-._"), ""))


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        request_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ImageHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag.lower() in {"img", "image", "source", "input"}:
            for key in ("src", "href", "xlink:href", "data-src"):
                if attrs.get(key):
                    self.urls.append(attrs[key])
            if attrs.get("srcset"):
                # Data URIs may contain commas; they have no whitespace inside.
                self.urls.extend(re.findall(r"(?:data:image/[^\s]+|https?://[^\s,]+|[^\s,]+)(?=\s+\d+(?:\.\d+)?[wx]|\s*(?:,|$))", attrs["srcset"]))
        if attrs.get("style"):
            self.urls.extend(m.group(2) for m in CSS_URL.finditer(attrs["style"]))

    handle_startendtag = handle_starttag


def string_image_urls(value: str, key: str = "") -> set[str]:
    found: set[str] = set()
    if key in IMAGE_KEYS and value.strip():
        return {normalize_url(value)}
    if "<" in value:
        parser = ImageHTMLParser()
        parser.feed(value)
        found.update(normalize_url(u) for u in parser.urls)
    else:
        found.update(normalize_url(m.group(2)) for m in CSS_URL.finditer(value))
    found.update(normalize_url(m.group(1)) for m in MARKDOWN_IMAGE.finditer(value))
    # Text copies sometimes contain a picture URL without an HTML tag.
    found.update(normalize_url(m.group(0)) for m in BARE_IMAGE.finditer(value))
    return found


def walk_strings(value, path="", key=""):
    if isinstance(value, dict):
        for k, child in value.items():
            if k != "data_base64":
                yield from walk_strings(child, path + "/" + str(k).replace("~", "~0").replace("/", "~1"), k)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from walk_strings(child, path + "/" + str(i), key)
    elif isinstance(value, str):
        yield path, key, value


def load_sources(source: Path):
    documents = {}
    for path in sorted(source.rglob("*.json")):
        relative = path.relative_to(source)
        if any(part in GENERATED_DIRS for part in relative.parts) or path.name in GENERATED_FILES:
            continue
        if path.is_symlink():
            raise ValueError(f"Refusing source symlink: {relative}")
        data = json.loads(path.read_text(encoding="utf-8"))
        # Four collection audit documents are not question packages.
        if isinstance(data, dict) and isinstance(data.get("questions"), list):
            documents[relative.as_posix()] = data
    return documents


def collect_references(documents):
    references = {}
    for file, document in documents.items():
        for pointer, key, value in walk_strings(document):
            for url in string_image_urls(value, key):
                item = references.setdefault(url, {"references": [], "embedded": [], "alternates": [], "expected_sha256": []})
                ref = {"file": file, "pointer": pointer}
                if ref not in item["references"]:
                    item["references"].append(ref)
        for metadata in document.get("images", []):
            if not isinstance(metadata, dict) or not isinstance(metadata.get("source_url"), str):
                continue
            url = normalize_url(metadata["source_url"])
            item = references.setdefault(url, {"references": [], "embedded": [], "alternates": [], "expected_sha256": []})
            if re.fullmatch(r"[0-9a-fA-F]{64}", metadata.get("sha256", "")):
                expected = metadata["sha256"].lower()
                if expected not in item["expected_sha256"]:
                    item["expected_sha256"].append(expected)
            if metadata.get("data_base64"):
                item["embedded"].append({"file": file, **metadata})
            if metadata.get("download_url"):
                alternate = normalize_url(metadata["download_url"])
                if alternate not in item["alternates"]:
                    item["alternates"].append(alternate)
    return references


def fetch_image(url: str, *, timeout: float, retries: int, context, max_bytes=MAX_IMAGE_BYTES):
    events = []
    try:
        actual = request_url(url)
    except ValueError as exc:
        return None, [{"outcome": "rejected_url", "error": str(exc)}]
    opener = build_opener(SafeRedirect(), HTTPSHandler(context=context))
    for attempt in range(1, retries + 2):
        event = {"attempt": attempt, "requested_url": actual, "method": "GET"}
        try:
            with opener.open(Request(actual, headers={"User-Agent": "SAT-Image-Archive/1.0", "Accept": "image/*"}), timeout=timeout) as response:
                event.update({"http_status": response.status, "final_url": response.geturl(),
                              "reported_content_type": response.headers.get_content_type()})
                data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError("Image exceeds the download size limit")
            image_type(data)
            event.update({"outcome": "downloaded", "bytes": len(data), "sha256": digest(data)})
            events.append(event)
            return data, events
        except HTTPError as exc:
            event.update({"outcome": "http_error", "http_status": exc.code, "error": str(exc)})
            events.append(event)
            if exc.code not in {408, 429, 500, 502, 503, 504}:
                break
        except ValueError as exc:
            event.update({"outcome": "invalid_image", "error": str(exc)})
            events.append(event)
            break
        except (URLError, TimeoutError, OSError) as exc:
            event.update({"outcome": "network_error", "error": str(exc)})
            events.append(event)
        if attempt <= retries:
            time.sleep(min(attempt, 2))
    return None, events


def recover_embedded(candidates):
    errors = []
    for item in candidates:
        try:
            expected = item.get("sha256", "")
            if not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
                raise ValueError("Embedded image has no valid expected SHA-256")
            data = base64.b64decode(item["data_base64"], validate=True)
            if len(data) > MAX_IMAGE_BYTES or digest(data) != expected.lower():
                raise ValueError("Embedded image size or SHA-256 mismatch")
            mime, _ = image_type(data)
            if item.get("mime_type") and item["mime_type"].lower() != mime:
                raise ValueError("Embedded image MIME type does not match its signature")
            return data, item["file"], errors
        except (ValueError, TypeError) as exc:
            errors.append({"file": item["file"], "error": str(exc)})
    return None, None, errors


def decode_inline(url: str):
    if not url.startswith("data:image/"):
        raise ValueError("Only inline image data can be decoded")
    header, payload = url.split(",", 1)
    if ";base64" in header:
        data = base64.b64decode(payload, validate=True)
    else:
        data = unquote_to_bytes(payload)
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Inline image exceeds the size limit")
    image_type(data)
    return data


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_output(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe output path: {relative}")
    # Reject a symlink anywhere above the file, including not-yet-created dirs.
    for parent in path.parents:
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError(f"Unsafe output directory: {relative}")
    return path


def rewrite_document(document, mapping, relative_file):
    replacements = {}
    for url, local_path in mapping.items():
        target = posixpath.relpath(local_path, posixpath.dirname("离线题包/" + relative_file))
        replacements[url] = target
        replacements[html.escape(url, quote=False)] = target
    # One pass prevents replacement text from matching another source URL.
    pattern = re.compile("|".join(re.escape(u) for u in sorted(replacements, key=len, reverse=True))) if replacements else None

    def transform(value):
        if isinstance(value, dict):
            result = {}
            for key, child in value.items():
                if key == "data_base64":
                    continue
                if key in {"source_url", "download_url"}:
                    # Provenance is held in 图片清单.json; this metadata points
                    # to the archived file when one actually exists.
                    result[key] = transform(child)
                else:
                    result[key] = transform(child)
            return result
        if isinstance(value, list):
            return [transform(child) for child in value]
        if isinstance(value, str) and pattern:
            return pattern.sub(lambda match: replacements[match.group(0)], value)
        return value

    return transform(document)


def check_offline_closure(source, documents, entries):
    """Resolve references actually present in rewritten JSON, not just its manifest."""
    asset_hashes = {item["local_path"]: item["sha256"] for item in entries if item.get("local_path")}
    unresolved = {}
    local_errors = []
    checked = 0
    for relative, document in documents.items():
        local_references = collect_references({relative: document})
        for url, details in local_references.items():
            scheme = urlsplit(url).scheme
            if scheme:
                unresolved.setdefault(relative, []).append(url)
                continue
            checked += len(details["references"])
            absolute = (source / "离线题包" / relative).parent / url
            try:
                resolved_relative = absolute.resolve().relative_to(source.resolve()).as_posix()
                expected = asset_hashes.get(resolved_relative)
                if expected is None or not absolute.is_file() or digest(absolute.read_bytes()) != expected:
                    raise ValueError("Referenced image is missing or differs from the manifest")
            except (ValueError, OSError) as exc:
                local_errors.append({"file": relative, "reference": url, "error": str(exc)})
    return {"local_reference_occurrences_checked": checked,
            "local_reference_errors": local_errors,
            "unresolved_external_references_by_file": unresolved,
            "all_local_references_resolve_and_match_sha256": not local_errors,
            "fully_offline": not unresolved and not local_errors}


def package(source: Path, *, workers=8, timeout=15.0, retries=1, ca_file=None, refresh=False, progress=None):
    source = source.resolve()
    if not source.is_dir():
        raise ValueError("Source must be an existing directory")
    documents = load_sources(source)
    if not documents:
        raise ValueError("No question JSON packages were found")
    references = collect_references(documents)
    context = ssl.create_default_context(cafile=ca_file)
    cache_file = safe_output(source, "下载报告.json")
    cached = {}
    if cache_file.exists() and not refresh:
        old = json.loads(cache_file.read_text(encoding="utf-8"))
        cached = {item["source_url"]: item for item in old.get("images", [])}

    def obtain(url, info):
        entry = {"source_url": url, "source_files": sorted({ref["file"] for ref in info["references"]}),
                 "references": info["references"], "network": [], "local_path": None,
                 "cache_reused": False, "network_log_origin": "current_run"}
        if info["expected_sha256"]:
            entry["expected_sha256"] = info["expected_sha256"]
        previous = cached.get(url)
        if previous and previous.get("local_path"):
            path = safe_output(source, previous["local_path"])
            if path.is_file():
                data = path.read_bytes()
                if (digest(data) == previous.get("sha256")
                        and (not info["expected_sha256"] or digest(data) in info["expected_sha256"])):
                    image_type(data)
                    entry.update({k: v for k, v in previous.items() if k not in {"source_files", "references"}})
                    entry["cache_reused"] = True
                    entry["network_log_origin"] = "previous_run"
                    return entry, data
        data = None
        if url.startswith("data:"):
            try:
                data = decode_inline(url)
                entry["status"] = "inline_extracted"
                entry["network"] = [{"outcome": "not_applicable_inline", "method": None}]
            except ValueError as exc:
                entry.update({"status": "failed", "error": str(exc)})
        else:
            data, entry["network"] = fetch_image(url, timeout=timeout, retries=retries, context=context)
            if data is not None:
                entry["status"] = "downloaded"
            # Alternate URLs are also independent references and have already
            # received their own GET. Their results are joined after fetching.
        if data is not None and info["expected_sha256"] and digest(data) not in info["expected_sha256"]:
            entry.update({"source_content_changed": True, "downloaded_sha256": digest(data),
                          "error": "Downloaded image differs from the source metadata SHA-256"})
            data = None
        if data is None and not url.startswith("data:"):
            data, recovered_from, errors = recover_embedded(info["embedded"])
            if errors:
                entry["embedded_validation_errors"] = errors
            if data is not None:
                entry.update({"status": "embedded_recovered", "embedded_source_file": recovered_from})
            else:
                entry["status"] = "failed"
        return entry, data

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(obtain, url, info): url for url, info in references.items()}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            url = futures[future]
            results[url] = future.result()
            entry, data = results[url]
            if data is not None:
                mime, suffix = image_type(data)
                local = "assets/" + digest(data) + suffix
                path = safe_output(source, local)
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.exists() or digest(path.read_bytes()) != digest(data):
                    path.write_bytes(data)
                entry.update({"local_path": local, "sha256": digest(data), "mime_type": mime, "bytes": len(data)})
            if progress and (i % 50 == 0 or i == len(futures)):
                progress(f"Images processed: {i}/{len(futures)}")
            if i % 50 == 0:
                write_json(cache_file, {"schema_version": 1, "in_progress": True,
                                       "images": [result[0] for result in results.values()]})
    for url, info in references.items():
        entry, data = results[url]
        # Prefer successful live alternate downloads over an embedded recovery.
        if entry["status"] in {"failed", "embedded_recovered"}:
            for alternate in info["alternates"]:
                alt_entry, alt_data = results.get(alternate, ({}, None))
                if alt_data is not None and alt_entry.get("status") == "downloaded":
                    expected = info["expected_sha256"]
                    if expected and digest(alt_data) not in expected:
                        entry.update({"alternate_content_changed": True, "alternate_sha256": digest(alt_data)})
                        continue
                    data = alt_data
                    entry.update({"status": "downloaded_alternate", "downloaded_from": alternate})
                    results[url] = (entry, data)
                    break
        if data is not None:
            mime, suffix = image_type(data)
            sha256 = digest(data)
            local = "assets/" + sha256 + suffix
            path = safe_output(source, local)
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists() or digest(path.read_bytes()) != sha256:
                path.write_bytes(data)
            entry.update({"local_path": local, "sha256": sha256, "mime_type": mime, "bytes": len(data)})
            if mime == "image/svg+xml":
                entry["svg_archived_without_execution"] = True

    entries = [results[url][0] for url in sorted(results)]
    mapping = {item["source_url"]: item["local_path"] for item in entries if item.get("local_path")}
    statuses = {status: sum(item["status"] == status for item in entries)
                for status in sorted({item["status"] for item in entries})}
    summary = {"source_json_packages": len(documents), "unique_image_references": len(entries),
               "unique_local_assets": len(set(mapping.values())), "status_counts": statuses,
               "failed_references": sum(item["status"] == "failed" for item in entries),
               "cache_reused_references": sum(bool(item.get("cache_reused")) for item in entries),
               "this_run_http_get_attempts": sum(len([event for event in item["network"] if event.get("method") == "GET"])
                                                 for item in entries if not item.get("cache_reused")),
               "source_json_modified": False,
               "personal_fields": "Source packages are archived as-is except image URLs/base64; this is not a sanitized website import."}
    manifest = {"schema_version": 1, "summary": summary, "images": [
        {k: v for k, v in item.items() if k not in {"network", "embedded_validation_errors"}} for item in entries]}
    write_json(safe_output(source, "图片清单.json"), manifest)
    offline_files = []
    offline_documents = {}
    for relative, document in documents.items():
        rewritten = rewrite_document(document, mapping, relative)
        output_relative = "离线题包/" + relative
        write_json(safe_output(source, output_relative), rewritten)
        offline_files.append(output_relative)
        offline_documents[relative] = rewritten
    closure = check_offline_closure(source, offline_documents, entries)
    closure["all_resolved_files_exist_and_hash_match"] = all(
        digest(safe_output(source, item["local_path"]).read_bytes()) == item["sha256"]
        for item in entries if item.get("local_path"))
    report = {"schema_version": 1, "summary": summary, "images": entries,
              "closure_check": closure}
    write_json(cache_file, report)
    readme = """# 耕读题目图片离线归档

原始 JSON 未修改。离线题包/ 保留原题数据，仅把已成功落盘的图片引用改为包内相对路径，并移除 data_base64；图片按 SHA-256 去重保存在 assets/。

图片清单.json 记录原地址、题包、JSON 位置、文件摘要、类型和大小。下载报告.json 额外记录每个 HTTP GET 的实际结果及无法离线的地址。downloaded 表示成功下载；downloaded_alternate 表示原地址失败后由备用地址成功下载；embedded_recovered 表示联网失败后由原 JSON 中通过摘要校验的内嵌图恢复；inline_extracted 表示原本内联的图片已解码归档；failed 表示无可用图片，原引用保留。

包内 SVG 仅作归档，未执行或渲染；正式接入网站前应通过 SVG 安全清理或转为受支持的静态图。该归档不会把任何题库导入网站，未删除源题包已有的个人字段。用于正式题库前仍须另行筛选，不能把本归档当作已匿名化的数据。

打开离线 JSON 的程序须以 JSON 文件所在目录解析相对图片路径。下载报告的 fully_offline 为 false 时，仍有源站失效图片；不得把这些题目当作完整题目。

复跑默认验证缓存摘要后复用已归档文件；--refresh 会重新请求每个来源。原始题包和本归档均仅留在本机，不应提交到 Git。
"""
    safe_output(source, "离线包说明.md").write_text(readme, encoding="utf-8")
    zip_path = safe_output(source, "耕读合集-图片离线包.zip")
    included = sorted(set(offline_files + list(mapping.values()) + ["图片清单.json", "下载报告.json", "离线包说明.md"]))
    temporary_zip = safe_output(source, "耕读合集-图片离线包.zip.tmp")
    with zipfile.ZipFile(temporary_zip, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative in included:
            archive.write(safe_output(source, relative), relative)
    with zipfile.ZipFile(temporary_zip) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(included):
            raise ValueError("ZIP verification failed")
    os.replace(temporary_zip, zip_path)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("耕读合集"))
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--ca-file", help="Optional trusted CA bundle; TLS verification stays enabled")
    parser.add_argument("--refresh", action="store_true", help="Request sources again instead of reusing verified files")
    args = parser.parse_args()
    if not 1 <= args.workers <= 16 or args.timeout <= 0 or not 0 <= args.retries <= 3:
        parser.error("workers must be 1–16, timeout positive, and retries 0–3")
    report = package(args.source, workers=args.workers, timeout=args.timeout, retries=args.retries,
                     ca_file=args.ca_file, refresh=args.refresh, progress=print)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
