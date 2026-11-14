import os

# Unit tests never talk to launchd; the real-launchd tests clear this on purpose.
os.environ.setdefault('OVERSEER_BROWSER_COALITION', 'direct')
