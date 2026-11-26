import atexit
import os
import shutil
import tempfile

# Unit tests never talk to launchd; the real-launchd tests clear this on purpose.
os.environ.setdefault('OVERSEER_BROWSER_COALITION', 'direct')

# CLI runs inside tests never check for updates or touch a real update state, install home or rollback copy.
_UPDATE_SANDBOX = tempfile.mkdtemp(prefix='osr-test-updates-')
atexit.register(shutil.rmtree, _UPDATE_SANDBOX, True)
os.environ.setdefault('OVERSEER_BROWSER_NO_UPDATE_CHECK', '1')
os.environ.setdefault('OVERSEER_BROWSER_CACHE_DIR', os.path.join(_UPDATE_SANDBOX, 'cache'))
os.environ.setdefault('OVERSEER_BROWSER_HOME', os.path.join(_UPDATE_SANDBOX, 'home'))
