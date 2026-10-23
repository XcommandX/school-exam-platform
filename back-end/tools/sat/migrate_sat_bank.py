#!/usr/bin/env python3
"""Explicitly migrate question content into ignored local storage, never records."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

REPOSITORY = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY / 'back-end'))
from shared.question_schema import normalize_question_set, referenced_assets, validate_question_set


def _plain_folder(path: Path) -> Path:
    if path.is_symlink() or not path.is_dir():
        raise ValueError('Source must be an existing real folder, not a symbolic link.')
    return path.resolve()


def _atomic_write(path: Path, payload: bytes, replace: bool) -> None:
    if path.is_symlink():
        raise ValueError('Refusing to write through a symbolic link.')
    if path.exists():
        if path.read_bytes() == payload:
            return
        if not replace:
            raise ValueError('Destination content differs. Review it and use --replace to update only question content.')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.migration-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def migrate(source_root: Path, private_root: Path, *, replace: bool = False,
            include_examples: bool = False, seed_json: Path | None = None) -> dict:
    source_root = _plain_folder(source_root)
    bank = _plain_folder(source_root / 'question-bank')
    assets = _plain_folder(source_root / 'question-assets')
    private_root = Path(os.path.abspath(private_root))
    # Do not permit ignored paths to become a redirect into tracked content.
    for path in (private_root, *private_root.parents):
        if path.is_symlink():
            raise ValueError('Destination folders must not be symbolic links.')
    if not private_root.is_relative_to(REPOSITORY):
        raise ValueError('Use an ignored local-data folder inside this repository.')
    ignored = subprocess.run(['git', 'check-ignore', '--quiet', '--', str(private_root / 'migration-probe.json')],
                             cwd=REPOSITORY, check=False)
    if ignored.returncode != 0:
        raise ValueError('Destination is not ignored by Git. Refusing to migrate private questions.')
    bank_files = sorted(bank.glob('*.json'))
    if not bank_files:
        raise ValueError('Source contains no JSON question sets.')
    files = [(path, path.name, 'bank') for path in bank_files]
    if seed_json is not None:
        files.append((Path(seed_json), 'data/questions.js', 'seed'))
    if include_examples:
        examples = source_root / 'data' / 'examples'
        if examples.is_symlink():
            raise ValueError('Example folder must not be a symbolic link.')
        files.extend((path, 'data/examples/' + path.name, 'example')
                     for path in sorted(examples.glob('*.json')))
    sets, pending, asset_payloads = [], [], {}
    known_questions = set()
    coverage = {'bank': 0, 'seed': 0, 'example': 0}
    privacy_fields_removed = 0
    supplementary_index = 0
    for path, source_key, source_kind in files:
        if path.is_symlink() or not path.is_file():
            raise ValueError('Question bank must contain only real JSON files.')
        if path.stat().st_size > 20 * 1024 * 1024:
            raise ValueError('A question set exceeds the 20 MB local import limit.')
        raw = json.loads(path.read_text(encoding='utf-8'))
        data = normalize_question_set(raw, exam='sat', source_key=source_key)
        def fingerprint(question):
            content = {key: question[key] for key in ('passage', 'prompt', 'options', 'correctOption')}
            return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if source_kind != 'bank':
            # Older examples often repeat content already present in the bank.
            # Keep the bank's edited version and add only otherwise absent items.
            unique = [question for question in data['questions'] if fingerprint(question) not in known_questions]
            if not unique:
                continue
            if len(unique) != len(data['questions']):
                data.pop('moduleQuestionCounts', None)
                data.pop('moduleDurationsSeconds', None)
                for question in unique:
                    question.pop('moduleIndex', None)
                    question.pop('questionNumberInModule', None)
            data['questions'] = unique
            data['title'] = 'SAT 原型示例题集' if source_kind == 'seed' else 'SAT 导入格式示例题集'
        known_questions.update(fingerprint(question) for question in data['questions'])
        coverage[source_kind] += len(data['questions'])
        # Preserve the questions of hand-collected sets without migrating labels
        # that describe the previous owner's wrong-book or practice history.
        if any(word in path.stem.lower() or word in data['title'].lower()
               for word in ('错题', 'wrong', 'mistake')):
            supplementary_index += 1
            data['title'] = f'SAT 补充题集 {supplementary_index:02d}'
        for question in raw['questions']:
            metadata = question.get('customMetadata', question.get('metadata', {}))
            if isinstance(metadata, dict):
                privacy_fields_removed += sum(key in metadata for key in
                    ('userSelectedAnswer', 'studentName', 'userId', 'attemptId', 'score', 'answerHistory'))
        for asset in referenced_assets(data):
            relative = Path(asset).relative_to('question-assets')
            original = assets / relative
            if original.is_symlink() or not original.is_file() or not original.resolve().is_relative_to(assets):
                raise ValueError('A referenced question image is missing or outside question-assets.')
            for parent in original.parents:
                if parent == assets:
                    break
                if parent.is_symlink():
                    raise ValueError('Question image folders must not be symbolic links.')
            asset_payloads[relative.as_posix()] = original.read_bytes()
        for question in data['questions']:
            visual = question.get('visualStimulus')
            if visual and visual.get('src'):
                visual['src'] = visual['src'].replace('question-assets/', 'question-assets/sat/', 1)
            metadata = question['customMetadata']
            if metadata.get('sourceTableImageAsset'):
                metadata['sourceTableImageAsset'] = metadata['sourceTableImageAsset'].replace('question-assets/', 'question-assets/sat/', 1)
        validate_question_set(data)
        filename = data['id'].replace(':', '-') + '.json'
        payload = (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        pending.append((private_root / 'question-banks' / 'sat' / filename, payload))
        sets.append({'id': data['id'], 'file': filename, 'kind': source_kind,
                     'questionCount': len(data['questions']),
                     'contentSha256': hashlib.sha256(payload).hexdigest()})
    if len({entry['id'] for entry in sets}) != len(sets):
        raise ValueError('Question source IDs collided.')
    for relative, payload in asset_payloads.items():
        pending.append((private_root / 'question-assets' / 'sat' / relative, payload))
    report = {'schemaVersion': 1, 'exam': 'sat', 'sourceCount': len(sets),
              'questionCount': sum(entry['questionCount'] for entry in sets),
              'originalBankQuestionCount': coverage['bank'],
              'originalSeedQuestionCount': coverage['seed'],
              'originalExampleQuestionCount': coverage['example'],
              'assetCount': len(asset_payloads), 'personalResponseFieldsRemoved': privacy_fields_removed,
              'practiceRecordsMigrated': 0, 'sets': sets}
    pending.append((private_root / 'sat-migration-report.json',
                    (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')))
    # Validate the complete plan before changing any destination content.
    for path, payload in pending:
        for parent in path.parents:
            if parent == private_root.parent:
                break
            if parent.is_symlink():
                raise ValueError('Destination folders must not be symbolic links.')
        if path.is_symlink() or (path.exists() and path.read_bytes() != payload and not replace):
            raise ValueError('Destination differs; no migration was applied. Review before --replace.')
    for exam in ('sat', 'ap', 'toefl', 'vocab'):
        (private_root / 'question-banks' / exam).mkdir(parents=True, exist_ok=True)
    for path, payload in pending:
        _atomic_write(path, payload, replace)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path,
                        help='Original SAT app folder containing question-bank and question-assets.')
    parser.add_argument('--private-root', '--local-root', dest='private_root', type=Path, default=REPOSITORY / 'local-data')
    parser.add_argument('--include-examples', action='store_true',
                        help='Include distinct JSON example questions from the original app.')
    parser.add_argument('--seed-json', type=Path,
                        help='Explicit sanitized JSON export of original JS seed questions; JS is never executed here.')
    parser.add_argument('--replace', action='store_true', help='Replace corrected question content after review.')
    args = parser.parse_args()
    try:
        report = migrate(args.source_root, args.private_root, replace=args.replace,
                         include_examples=args.include_examples, seed_json=args.seed_json)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f'Question migration stopped: {exc}') from exc
    print(json.dumps({k: v for k, v in report.items() if k != 'sets'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
