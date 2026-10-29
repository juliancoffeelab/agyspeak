"""Create a persistent local signing key; never replace an existing one."""
import os
from pathlib import Path
import secrets
import subprocess

root = Path(__file__).resolve().parents[1] / '.signing'
root.mkdir(mode=0o700, exist_ok=True)
properties = root / 'release.properties'
keystore = root / 'release.keystore'
if properties.exists():
    if not keystore.exists():
        raise SystemExit('Signing properties exist but the keystore is missing. Restore your signing-key backup.')
    raise SystemExit(0)
if keystore.exists():
    raise SystemExit('Keystore exists but properties are missing. Restore the properties; the key will not be replaced.')
password = secrets.token_urlsafe(32)
env = {**os.environ, 'AGYSPEAK_KEY_PASSWORD': password}
subprocess.run([
    'keytool', '-genkeypair', '-noprompt', '-keystore', str(keystore),
    '-alias', 'agyspeak', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass:env', 'AGYSPEAK_KEY_PASSWORD', '-keypass:env', 'AGYSPEAK_KEY_PASSWORD',
    '-dname', 'CN=AGSpeak',
], check=True, env=env)
keystore.chmod(0o600)
fd = os.open(properties, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write(f'storeFile=release.keystore\nstorePassword={password}\nkeyAlias=agyspeak\nkeyPassword={password}\n')
print('Created a local release signing key in .signing/. Keep a private backup of this directory.')
