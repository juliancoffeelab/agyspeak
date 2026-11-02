import hashlib
import zipfile

import pytest

from agyspeak import acp_runtime


@pytest.fixture
def runtime_archive(monkeypatch, tmp_path):
    archive = tmp_path / 'runtime.zip'
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('agy_acp_server.par', 'agent')
        bundle.writestr('localharness_external', 'harness')
        bundle.writestr('../unwanted', 'never extract this')
    monkeypatch.setattr(acp_runtime.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(acp_runtime.platform, 'machine', lambda: 'arm64')
    directory = tmp_path / 'installed'
    monkeypatch.setattr(acp_runtime, 'RUNTIME_DIR', directory)
    monkeypatch.setattr(acp_runtime, 'RUNTIME_BINARY', directory / 'agy_acp_server.par')
    return archive, directory


def test_installer_verifies_archive_before_writing(runtime_archive):
    archive, directory = runtime_archive
    with pytest.raises(RuntimeError, match='checksum'):
        acp_runtime.install(archive)
    assert not directory.exists()


def test_installer_keeps_executable_pair_and_only_extracts_expected_files(monkeypatch, runtime_archive):
    archive, directory = runtime_archive
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    monkeypatch.setattr(acp_runtime, 'RELEASES', {('Darwin', 'arm64'): ('macos', 'darwin-arm64', digest)})
    assert acp_runtime.install(archive) == directory / 'agy_acp_server.par'
    assert (directory / 'agy_acp_server.par').read_text() == 'agent'
    assert (directory / 'localharness_external').read_text() == 'harness'
    assert all(file.stat().st_mode & 0o111 for file in directory.iterdir())
    assert not (archive.parent / 'unwanted').exists()
