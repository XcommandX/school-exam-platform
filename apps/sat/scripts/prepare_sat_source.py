#!/usr/bin/env python3
"""Create a new, source-only SAT prototype directory from a fixed allowlist.

No repository traversal, original question data, Git operation, or network access
is used. Review the resulting directory before adding it to another repository.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


# Keep this explicit: newly added application files require a deliberate review.
COPY_FILES = (
    "html/index.html",
    "css/base.css",
    "css/exam.css",
    "css/dashboard.css",
    "css/exam-math.css",
    "css/math-tools.css",
    "css/content-renderer.css",
    "js/sat-pack.js",
    "js/sat-session.js",
    "js/math-tools.js",
    "js/content-renderer.js",
    "vendor/README.md",
    "vendor/dompurify/LICENSE",
    "vendor/dompurify/LICENSE-MPL",
    "vendor/dompurify/purify.min.js",
    "vendor/dompurify-metadata.json",
    "vendor/katex/LICENSE",
    "vendor/katex/README.md",
    "vendor/katex/fonts/KaTeX_AMS-Regular.ttf",
    "vendor/katex/fonts/KaTeX_AMS-Regular.woff",
    "vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Caligraphic-Bold.ttf",
    "vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff",
    "vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
    "vendor/katex/fonts/KaTeX_Caligraphic-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff",
    "vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Fraktur-Bold.ttf",
    "vendor/katex/fonts/KaTeX_Fraktur-Bold.woff",
    "vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
    "vendor/katex/fonts/KaTeX_Fraktur-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Fraktur-Regular.woff",
    "vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Main-Bold.ttf",
    "vendor/katex/fonts/KaTeX_Main-Bold.woff",
    "vendor/katex/fonts/KaTeX_Main-Bold.woff2",
    "vendor/katex/fonts/KaTeX_Main-BoldItalic.ttf",
    "vendor/katex/fonts/KaTeX_Main-BoldItalic.woff",
    "vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
    "vendor/katex/fonts/KaTeX_Main-Italic.ttf",
    "vendor/katex/fonts/KaTeX_Main-Italic.woff",
    "vendor/katex/fonts/KaTeX_Main-Italic.woff2",
    "vendor/katex/fonts/KaTeX_Main-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Main-Regular.woff",
    "vendor/katex/fonts/KaTeX_Main-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Math-BoldItalic.ttf",
    "vendor/katex/fonts/KaTeX_Math-BoldItalic.woff",
    "vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
    "vendor/katex/fonts/KaTeX_Math-Italic.ttf",
    "vendor/katex/fonts/KaTeX_Math-Italic.woff",
    "vendor/katex/fonts/KaTeX_Math-Italic.woff2",
    "vendor/katex/fonts/KaTeX_SansSerif-Bold.ttf",
    "vendor/katex/fonts/KaTeX_SansSerif-Bold.woff",
    "vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
    "vendor/katex/fonts/KaTeX_SansSerif-Italic.ttf",
    "vendor/katex/fonts/KaTeX_SansSerif-Italic.woff",
    "vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
    "vendor/katex/fonts/KaTeX_SansSerif-Regular.ttf",
    "vendor/katex/fonts/KaTeX_SansSerif-Regular.woff",
    "vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Script-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Script-Regular.woff",
    "vendor/katex/fonts/KaTeX_Script-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Size1-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Size1-Regular.woff",
    "vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Size2-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Size2-Regular.woff",
    "vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Size3-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Size3-Regular.woff",
    "vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Size4-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Size4-Regular.woff",
    "vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
    "vendor/katex/fonts/KaTeX_Typewriter-Regular.ttf",
    "vendor/katex/fonts/KaTeX_Typewriter-Regular.woff",
    "vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2",
    "vendor/katex/katex.min.css",
    "vendor/katex/katex.min.js",
    "vendor/katex-metadata.json",
    "vendor/marked/LICENSE",
    "vendor/marked/marked.umd.js",
    "vendor/marked-metadata.json",
    "js/app.js",
    "js/storage.js",
    "js/question-bank.js",
    "js/material-text.js",
    "js/exam.js",
    "js/importer.js",
    "js/shortcuts.js",
    "js/line-reader.js",
    "js/practice-model.js",
    "data/question-categories.js",
    "data/question-categories.json",
    "scripts/question_bank_server.py",
    "Start SAT Practice.command",
    "scripts/prepare_sat_source.py",
)
# Only these individually allowlisted KaTeX fonts may contain binary data.
# Other COPY_FILES must remain UTF-8 source text with no NUL bytes.
FONT_SIGNATURES = {".ttf": b"\x00\x01\x00\x00", ".woff": b"wOFF", ".woff2": b"wOF2"}
BINARY_SOURCE_FILES = frozenset(
    name for name in COPY_FILES
    if name.startswith("vendor/katex/fonts/") and Path(name).suffix in FONT_SIGNATURES
)
GENERATED_FILES = (
    "data/questions.js",
    "data/examples/synthetic-practice.json",
    "README.md",
    ".gitignore",
)
MANIFEST = "SOURCE_MANIFEST.json"
INITIALIZATION = (
    "if(SATBank.state.mode==='browser')"
    "await SATStorage.migrateDefaults(questions);"
)
EMPTY_SAFE_INITIALIZATION = (
    "if(SATBank.state.mode==='browser'&&questions.length)"
    "await SATStorage.migrateDefaults(questions);"
)
CATEGORY_JS_PREFIX = (
    "// Generated from question-categories.json for file:// use. Do not edit independently.\n"
    "window.SATCategoryData = "
)
CLEAN_CATEGORY_JS_PREFIX = (
    "// Generated taxonomy; local reference paths omitted.\n"
    "window.SATCategoryData = "
)
LAUNCH_COMMAND = "scripts/question_bank_server.py --open"
ISOLATED_LAUNCH_COMMAND = "scripts/question_bank_server.py --port 8876 --open"
SERVER_FACTORY = "def create_server(root, port=8765):"
ISOLATED_SERVER_FACTORY = "def create_server(root, port=8876):"
SERVER_PORT_ARGUMENT = "parser.add_argument('--port', type=int, default=8765)"
ISOLATED_SERVER_PORT_ARGUMENT = "parser.add_argument('--port', type=int, default=8876)"

README = """# SAT 独立练习原型（仅源码）

这是一个 SAT Reading and Writing 与 Math 独立练习原型，保留源码供继续开发和整合。它尚未接入学校平台的统一登录与云端记录，也不包含正式考试题库。OCR 功能已取消，支持旧 JSON 题目导入及 SAT 专用题目包文件夹导入；新包用 Markdown 与 LaTeX，数学支持四选一、填空、Reference 和图片查看工具。计算器只提供入口与布局位移。

## 运行与测试

需要 Python 3.10 或更新版本及现代浏览器。在此目录中运行：

```sh
python3 scripts/question_bank_server.py --port 8876
```

打开 http://127.0.0.1:8876/html/index.html 。若该端口已占用，请换一个空闲端口并相应修改地址。使用与其他练习环境不同的端口，确保浏览器来源不同，从而隔离 IndexedDB 和 localStorage 中的题库与作答记录；请勿连接原先使用的题库文件夹。

内置题库为空，页面首次启动应显示 0 道题。可在 Add Questions 中手动导入 `data/examples/synthetic-practice.json`，其中两道题为完全原创的合成测试数据，仅用于验证导入与练习流程。它们不是正式 SAT 试题。

本副本的服务器和 macOS 便捷启动器 `Start SAT Practice.command` 均默认使用独立端口 8876。若该端口已有其他练习环境，请使用上面的命令另选端口，以隔离既有浏览器记录。

服务器首次运行会在本副本中新建空的 `question-bank/`。导入后的题目与答案属于本地运行数据，默认不纳入版本管理。停止服务可在启动终端按 Control-C。

## 数据边界

本导出仅复制逐个指定的前端与本地服务源码及通用题型定义。原题库、原答案、个人练习记录、浏览器记录导出、HAR、PDF、备份、题目图片和 OCR 结果均未复制。通用题型定义已移除本地参考图片路径。`data/questions.js` 为新生成的空数组占位文件；前端初始化同时跳过空题库的默认来源迁移。

浏览器里的记录不在此源码包中。不要将本地运行生成的数据、已有题库或浏览器导出文件手动添加到发布提交。`.gitignore` 默认忽略所有未明确允许的文件；新源码也需经过审查后逐个放行。忽略规则不能阻止强制添加，也不能清除已经被其他仓库跟踪的文件。

## 功能与集成限制

OCR 上传界面、任务代码和服务 API 已删除。此副本不包含 OCR 模型、运行环境或依赖，不支持 PDF 上传与识别；请使用 JSON 导入题目。核心页面和本地题库 API 仅使用 Python 标准库即可启动。

该原型以浏览器 IndexedDB 和 localStorage 保存题库、练习、错题和设置，Python 服务仅监听本机回环地址。它不提供学校平台的账号、权限、多人共享、服务端成绩存储或远程部署能力。正式集成需要适配目标项目的路由、鉴权、数据模型、资源路径与后端接口，并按该项目要求验证。

## 重新生成与核对

`scripts/prepare_sat_source.py` 使用固定白名单生成新的目录，目标必须不存在。默认目标为 `tmp/sat-source-only`，也可用 `--output` 指定新目录；拒绝路径穿越和符号链接。不要把运行生成的数据混入导出。

`SOURCE_MANIFEST.json` 记录各交付文件的相对路径、SHA-256 和生成或复制方式。修改过初始化条件的 `js/app.js`、移除本地参考图片路径的题型定义、使用独立端口的服务器和启动器均标记为生成。清单本身不计算自身哈希，以避免循环依赖；除此之外，所有交付文件均应有对应条目。该清单用于核对导出内容，不代表目标平台已完成集成。
"""


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def relative_path(name):
    path = Path(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError("Allowlist paths must be relative and cannot traverse parents.")
    return path


def reject_symlinks(path):
    """Check the path itself and every ancestor without resolving links first."""
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Symbolic links are not allowed in source or destination paths.")


def destination_path(raw, root):
    candidate = Path(raw) if raw is not None else root / "tmp/sat-source-only"
    if ".." in candidate.parts:
        raise ValueError("Output paths cannot contain parent traversal.")
    destination = candidate.absolute()
    reject_symlinks(destination)
    if destination.exists():
        raise ValueError("Output directory already exists; choose a new directory.")
    return destination


def ignore_rules():
    allowed = (*COPY_FILES, *GENERATED_FILES, MANIFEST)
    directories = set()
    for name in allowed:
        for parent in relative_path(name).parents:
            if parent != Path("."):
                directories.add(parent.as_posix())
    lines = [
        "# Deny new files by default. Review each additional source explicitly.",
        "*",
    ]
    lines.extend(f"!/{name}/" for name in sorted(directories, key=lambda p: (p.count("/"), p)))
    lines.extend(f"!/{name}" for name in sorted(allowed))
    lines.extend([
        "",
        "# Local runtime and private material remain excluded.",
        "/question-bank/", "/question-assets/", "/question-bank-backups/", "/OCR/",
        "**/*.har", "**/*.HAR", "**/*.pdf", "**/*.PDF", "**/*.log",
        "**/__pycache__/", "**/.venv/", "**/backups/", "**/*.bak", "**/.DS_Store",
        "**/models/", "**/model-cache/", "**/.cache/",
        "**/*.onnx", "**/*.safetensors", "**/*.pt", "**/*.pth", "**/*.ckpt",
    ])
    return "\n".join(lines) + "\n"


def generated_contents():
    sample = {
        "title": "Synthetic Test Practice - Original Test Data",
        "section": "Reading and Writing",
        "durationMinutes": 2,
        "questions": [
            {
                "passage": "Mira moved a library notice from a side wall to the entrance. During the next week, more visitors asked about the event described in the notice.",
                "prompt": "Which conclusion is best supported by the text?",
                "options": [
                    "The new location may have helped visitors notice the event.",
                    "The library stopped holding events.",
                    "Every visitor attended the event.",
                    "The notice described a different library.",
                ],
                "answer": "A",
                "questionType": "",
                "explanation": "Original synthetic test item: more questions followed the move to a more visible location; the text does not establish attendance.",
            },
            {
                "passage": "A town installed a small rain gauge in its public garden. Volunteers record its reading at noon each day, creating a consistent record of local rainfall.",
                "prompt": "What is the main purpose of the volunteers' daily readings?",
                "options": [
                    "To predict the exact weather for the next year",
                    "To collect comparable observations over time",
                    "To keep visitors out of the garden",
                    "To replace all measurements of temperature",
                ],
                "answer": "B",
                "questionType": "",
                "explanation": "Original synthetic test item: using the same daily measurement time supports a consistent record.",
            },
        ],
    }
    return {
        "data/questions.js": (
            "'use strict';\n"
            "// Generated empty baseline. No original questions or personal records.\n"
            'const studentName = "Student";\n'
            "const questions = [];\n"
        ),
        "data/examples/synthetic-practice.json": json_text(sample),
        "README.md": README,
        ".gitignore": ignore_rules(),
    }


def known_transformation(text, original, cleaned, label):
    """Accept exactly one known original or already-cleaned fragment."""
    original_count, cleaned_count = text.count(original), text.count(cleaned)
    if original_count == 1 and cleaned_count == 0:
        return text.replace(original, cleaned, 1)
    if original_count == 0 and cleaned_count == 1:
        return text
    raise ValueError(f"{label} changed; review the export transformation.")


def sanitized_categories(sources):
    categories = json.loads(sources["data/question-categories.json"].read_text(encoding="utf-8"))
    javascript = sources["data/question-categories.js"].read_text(encoding="utf-8")
    prefixes = [prefix for prefix in (CATEGORY_JS_PREFIX, CLEAN_CATEGORY_JS_PREFIX)
                if javascript.startswith(prefix)]
    if len(prefixes) != 1 or not javascript.endswith(";\n"):
        raise ValueError("Question category JavaScript wrapper changed; review the export transformation.")
    try:
        javascript_data = json.loads(javascript[len(prefixes[0]):-2])
    except ValueError as exc:
        raise ValueError("Question category JavaScript is not the expected single JSON binding.") from exc
    if javascript_data != categories:
        raise ValueError("Question category JSON and JavaScript differ; review them before export.")
    if (not isinstance(categories, dict) or categories.get("version") != 1
            or not isinstance(categories.get("categories"), list)
            or not categories["categories"]
            or any(not isinstance(item, dict) for item in categories["categories"])):
        raise ValueError("Question category structure changed; review the export transformation.")
    if prefixes[0] == CLEAN_CATEGORY_JS_PREFIX and any("reference" in item for item in categories["categories"]):
        raise ValueError("Cleaned question categories contain unexpected references; review them before export.")
    for item in categories["categories"]:
        item.pop("reference", None)
    return {
        "data/question-categories.json": json_text(categories),
        "data/question-categories.js": (
            CLEAN_CATEGORY_JS_PREFIX
            + json.dumps(categories, ensure_ascii=False)
            + ";\n"
        ),
    }


def validate_source_file(name, source):
    if name in BINARY_SOURCE_FILES:
        data = source.read_bytes()
        if len(data) < 12 or not data.startswith(FONT_SIGNATURES[Path(name).suffix]):
            raise ValueError(f"Required font has an invalid signature: {name}")
    elif "\x00" in source.read_text(encoding="utf-8"):
        raise ValueError(f"Required source contains binary data: {name}")


def prepare(root, destination):
    reject_symlinks(root)
    sources = {}
    for name in COPY_FILES:
        source = root / relative_path(name)
        reject_symlinks(source)
        if not source.is_file():
            raise ValueError(f"Required source is missing: {name}")
        validate_source_file(name, source)
        sources[name] = source
    app = sources["js/app.js"].read_text(encoding="utf-8")
    generated = generated_contents()
    generated["js/app.js"] = known_transformation(
        app, INITIALIZATION, EMPTY_SAFE_INITIALIZATION, "Application initialization")
    generated.update(sanitized_categories(sources))
    launcher = sources["Start SAT Practice.command"].read_text(encoding="utf-8")
    generated["Start SAT Practice.command"] = known_transformation(
        launcher, LAUNCH_COMMAND, ISOLATED_LAUNCH_COMMAND, "Launcher command")
    server = sources["scripts/question_bank_server.py"].read_text(encoding="utf-8")
    server = known_transformation(
        server, SERVER_FACTORY, ISOLATED_SERVER_FACTORY, "Server factory port")
    generated["scripts/question_bank_server.py"] = known_transformation(
        server, SERVER_PORT_ARGUMENT, ISOLATED_SERVER_PORT_ARGUMENT, "Server command-line port")

    # All inputs have been checked before any output directory is created.
    destination.mkdir(parents=True, exist_ok=False)
    entries = []
    for name in sorted(set(COPY_FILES) | set(generated)):
        target = destination / relative_path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if name in generated:
            target.write_text(generated[name], encoding="utf-8", newline="\n")
            method = "generated"
        else:
            shutil.copyfile(sources[name], target, follow_symlinks=False)
            reject_symlinks(target)
            method = "copied"
        if name in {"Start SAT Practice.command", "scripts/prepare_sat_source.py"}:
            target.chmod(0o755)
        entries.append({
            "path": name,
            "method": method,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        })
    manifest = {
        "schema_version": 1,
        "hash_algorithm": "sha256",
        "manifest_file": MANIFEST,
        "manifest_is_not_self_hashed": True,
        "files": entries,
    }
    (destination / MANIFEST).write_text(json_text(manifest), encoding="utf-8", newline="\n")
    return len(entries) + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="A new output directory; existing directories are refused.")
    args = parser.parse_args()
    root = Path(__file__).absolute().parent.parent
    try:
        destination = destination_path(args.output, root)
        count = prepare(root, destination)
    except (OSError, UnicodeError, ValueError) as exc:
        parser.exit(1, f"Export refused: {exc}\n")
    print(f"Prepared {count} allowlisted source/generated files. No Git or network operations performed.")


if __name__ == "__main__":
    main()
