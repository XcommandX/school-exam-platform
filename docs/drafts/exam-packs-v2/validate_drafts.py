#!/usr/bin/env python3
"""Read-only checks for these ORIGINAL STRUCTURE DRAFTS, not a v2 importer.

This does not certify exam accuracy, playable media, rendering, scoring, a
complete JSON Schema, or safe import of arbitrary third-party archives.
"""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
PACKS = ('sat-math', 'ap', 'toefl-2026')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def local_path(folder, name):
    require(isinstance(name, str) and name, 'Path must be nonempty text.')
    relative = Path(name)
    require(not relative.is_absolute() and '\\' not in name and '\x00' not in name
            and not any(part in ('.', '..') for part in name.split('/')), 'Invalid local path: ' + name)
    target = folder / relative
    require(not target.is_symlink(), 'Symbolic links are not draft assets.')
    require(target.resolve().is_relative_to(folder.resolve()), 'Path escapes sample pack.')
    return target


def id_map(rows, label):
    result = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('id'), str), label + ': missing ID.')
        require(row['id'] not in result, label + ': duplicate ID ' + row['id'])
        result[row['id']] = row
    return result


def check_pack(name):
    folder = ROOT / name
    pack = json.loads((folder / 'pack.json').read_text(encoding='utf-8'))
    require(pack['schemaVersion'] == '2.0-draft' and pack['status'] == 'draft', name + ': not marked draft.')
    require(pack['documentType'] == 'exam-pack', name + ': wrong document kind.')
    require(isinstance(pack['revision'], str), name + ': revision must be text.')
    require(set(pack['files']) == {'assessment', 'items', 'solutions'}, name + ': unexpected file registry.')
    docs = {kind: json.loads(local_path(folder, path).read_text(encoding='utf-8'))
            for kind, path in pack['files'].items()}
    assessment, content, answer_doc = (docs[k] for k in ('assessment', 'items', 'solutions'))
    require(assessment['profile']['assemblyStatus'] == 'incomplete', name + ': specimen must declare incomplete assembly.')
    require(answer_doc['visibility'] == 'instructor-only', name + ': solutions visibility missing.')
    items = id_map(content['items'] + content.get('assessmentTasks', []), name + ' items/tasks')
    materials = id_map(content['materials'], name + ' materials')
    assets = id_map(pack['assets'], name + ' assets')
    tools = id_map(pack['toolRequirements'], name + ' tools')
    sources = id_map(pack['references'], name + ' references')
    solutions = id_map(answer_doc['solutions'], name + ' solutions')
    sections = id_map(assessment['sections'], name + ' sections')
    documents = [pack, *docs.values()]
    defined_ids = {node['id'] for doc in documents for node in walk(doc)
                   if isinstance(node.get('id'), str)}

    # Verify declared internal references including source, stage and policy IDs.
    for doc in documents:
        for node in walk(doc):
            for key, value in node.items():
                references = value if key.endswith('Refs') and isinstance(value, list) else [value] if key.endswith('Ref') else []
                for reference in references:
                    if reference is not None:
                        require(isinstance(reference, str) and reference in defined_ids,
                                f'{name}: unresolved {key}={reference!r}')
                if key in {'assetId', 'stateAssetId', 'fallbackAssetId', 'authorInitialStateAssetId', 'templateAssetId'} and value is not None:
                    require(value in assets, f'{name}: missing asset {value}')
                if key == 'toolId' and value is not None:
                    require(value in tools, f'{name}: missing tool {value}')
            for ref in node.get('stimulusRefs', []):
                require(ref in materials, f'{name}: missing material {ref}')
            for ref in node.get('itemRefs', []):
                require(ref in items, f'{name}: missing item/task {ref}')
            for key in ('allowedToolIds', 'requiredToolIds'):
                for ref in node.get(key, []):
                    require(ref in tools, f'{name}: missing permitted tool {ref}')

    seen_solutions, part_count = set(), 0
    for item_id, item in items.items():
        require(isinstance(item['revision'], str), name + ': item revision must be text.')
        require(item['sectionId'] in sections, name + ': missing item section.')
        parts = list(node for node in walk(item.get('parts', [])) if 'interactions' in node and 'solutionId' in node)
        require(parts, name + ': every task needs a scored/reference part.')
        id_map(parts, name + ' parts within ' + item_id)
        for part in parts:
            part_count += 1
            require(part['solutionId'] in solutions, name + ': part lacks solution.')
            solution = solutions[part['solutionId']]
            require(solution['itemId'] == item_id and solution['partId'] == part['id'], name + ': answer points at another part.')
            require(solution['id'] not in seen_solutions, name + ': solution reused for another part.')
            seen_solutions.add(solution['id'])
            interactions = id_map(part['interactions'], name + ' part interactions')
            scoring = solution['scoring']
            require(scoring['mode'] in ('automatic', 'rubric', 'manual', 'external'), name + ': unrecognized scoring mode.')
            require(isinstance(scoring['maxScore'], (int, float)) and scoring['maxScore'] >= 0, name + ': invalid score.')
            explanation = solution['explanation']
            require(bool(explanation.get('status')) and bool(explanation.get('content')), name + ': missing explanation/status.')
            if scoring['mode'] == 'automatic':
                require(bool(scoring['rules']), name + ': automatic response has no expected answer rule.')
            else:
                require(bool(scoring.get('rubric', {}).get('criteria')) and bool(scoring.get('modelResponses')),
                        name + ': open response needs a rubric and reference answer.')
            for rule in scoring.get('rules', []):
                require(rule['interactionId'] in interactions, name + ': rule refers to another interaction.')
                if rule['kind'] == 'option-set' and isinstance(rule.get('expected'), list):
                    options = id_map(interactions[rule['interactionId']]['options'], name + ' options')
                    require(all(option in options for option in rule['expected']), name + ': answer option missing.')
    require(seen_solutions == set(solutions), name + ': orphan solutions.')

    included, placeholders = 0, 0
    for asset in assets.values():
        path = local_path(folder, asset['path'])
        require(asset['status'] in ('included', 'placeholder'), name + ': missing resource status.')
        if asset['status'] == 'included':
            require(path.is_file(), name + ': declared included resource missing.')
            require(hashlib.sha256(path.read_bytes()).hexdigest() == asset['sha256'], name + ': wrong asset checksum.')
            if asset['mediaType'] == 'image/svg+xml':
                svg = ET.fromstring(path.read_text(encoding='utf-8'))
                require(svg.tag.endswith('svg'), name + ': invalid SVG.')
                require(not any(n.tag.split('}')[-1] in {'script', 'foreignObject'} for n in svg.iter()), name + ': unexpected SVG executable content.')
            included += 1
        else:
            require(asset['sha256'] is None, name + ': placeholder must not claim a usable checksum.')
            # A descriptive graph-state placeholder may exist, but is not usable
            # graph data and must not be promoted to an included resource.
            placeholders += 1
    for tool in tools.values():
        if tool['provider'] == 'desmos':
            require(tool['runtimeRegistryKey'] == 'desmos.shared', name + ': Desmos must use the shared platform runtime.')
    print(f'{name}: {len(items)} items/tasks, {part_count} parts/solutions, {included} included original assets, {placeholders} declared placeholders — PASS')


def main():
    for path in ROOT.rglob('*.json'):
        json.loads(path.read_text(encoding='utf-8'))
    for name in PACKS:
        check_pack(name)
    print('Draft structure/reference checks only; no media, renderer, Desmos or scoring runtime certification.')


if __name__ == '__main__':
    main()
