"""
Shared pieces of the mutation runners (scripts/review/*_mutants.py), open-source step 6: the runners work in the public
repository and without the private sibling packages, not only in the author's tree.

  python_cmd(fallback)    command for the Python tests: [$AEGISTALK_PYTHON] if set, else the runner's own fallback (its
                          `uv run --with …` command) when that tool is installed, else [this interpreter]
  make_copy(dst, ...)     copy the folders / files a runner needs into dst. A path this checkout does not have (official-only
                          files, editions/chat in the public tree, public/voice-test.html) is left out. The node_modules the
                          app resolves its packages from (packages/pwa/node_modules, or a hoisted one above it) is linked into
                          the copy as packages/pwa/node_modules, so the tests find esbuild wherever the copy is (they used to
                          rely on a node_modules folder above the default copy location)
  official_mutants(name)  the runner's mutants that change official-only code, or that only official-only tests can catch,
                          from scripts/review/mutants_official.py ([] when that file is not in this checkout — the public
                          repository does not have it)
  runnable(mutants)       what can run here: a mutant whose file is absent is SKIP; a test that is absent is dropped from a
                          mutant (a mutant left without tests is SKIP). One line per decision; SKIPPED keeps the names.
                          A mutant is (name, file, [(old, new), ...], [tests], ...); a test is "<name>" for
                          scripts/review/<name>_self_test.mjs, "py:<name>" for <name>_self_test.py, "jvm:<Class>" (the runner
                          handles those itself).
"""
import importlib.util
import os
import shutil
import sys
from pathlib import Path

REVIEW = Path(__file__).resolve().parent
REPO = REVIEW.parents[1]
OFFICIAL = REVIEW / 'mutants_official.py'
#: names of the mutants runnable() skipped (the runners report the count)
SKIPPED = []


def python_cmd(fallback=None):
    env = os.environ.get('AEGISTALK_PYTHON')
    if env:
        return [env]
    if fallback and shutil.which(fallback[0]):
        return list(fallback)
    return [sys.executable]


def _app_modules():
    """the node_modules folder that packages/pwa resolves esbuild from (node's lookup: that folder, then its parents)"""
    pwa = REPO / 'packages/pwa'
    for d in (pwa, *pwa.parents):
        if (d / 'node_modules' / 'esbuild' / 'package.json').is_file():
            return d / 'node_modules'
    return None


def make_copy(dst, dirs, files, ignore=('__pycache__', 'node_modules')):
    dst = Path(dst)
    shutil.rmtree(dst, ignore_errors=True)
    for d in dirs:
        if (REPO / d).is_dir():
            shutil.copytree(REPO / d, dst / d, ignore=shutil.ignore_patterns(*ignore))
    for f in files:
        if (REPO / f).is_file():
            (dst / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / f, dst / f)
    modules = _app_modules()
    link = dst / 'packages/pwa/node_modules'
    if modules and not link.exists():
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(modules, target_is_directory=True)


def official_mutants(runner):
    if not OFFICIAL.is_file():
        return []
    spec = importlib.util.spec_from_file_location('mutants_official', OFFICIAL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return list(mod.MUTANTS.get(runner, []))


def _test_file(test):
    if test.startswith('jvm:'):
        return None
    if test.startswith('py:'):
        return REVIEW / f'{test[3:]}_self_test.py'
    return REVIEW / f'{test}_self_test.mjs'


def runnable(mutants):
    out = []
    for m in mutants:
        name, target, reps, tests = m[0], m[1], m[2], m[3]
        if not (REPO / target).exists():
            SKIPPED.append(name)
            print(f'SKIP {name}: {target} is not in this checkout (official edition)', flush=True)
            continue
        present = [t for t in tests if _test_file(t) is None or _test_file(t).exists()]
        gone = [t for t in tests if t not in present]
        if not present:
            SKIPPED.append(name)
            print(f'SKIP {name}: its tests ({", ".join(gone)}) are not in this checkout (official edition)', flush=True)
            continue
        if gone:
            print(f'note {name}: runs without {", ".join(gone)} (not in this checkout)', flush=True)
        out.append((name, target, reps, present) + tuple(m[4:]))
    return out
