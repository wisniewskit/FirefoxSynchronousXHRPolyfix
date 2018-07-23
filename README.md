# FirefoxSynchronousXHRPolyfix
A polyfix for https://bugzil.la/697151

## Usage

Just include FirefoxSyncXHRPolyfix.js in your web-page before
any scripts which use XMLHttpRequests:

```
<script src="FirefoxSyncXHRPolyfix.js"></script>
```

## Details

This polyfix tries to mitigate a Firefox interop issue wherein
async XHR events and postMessages can fire before an ongoing
sync XHRs' events are handled (https://bugzil.la/697151).

This is designed to only actually polyfix when necessary, and to
not use any features which would cause parsing errors on older
browsers, and to use as few modern JS-isms as possible so that it
is backward-compatible down to Firefox 6 (which has WeakMap).

In a nutshell, the fix blocks async XHR events and postMessages
from firing while any sync XHR is ongoing, to match what other
browsers do.

Note however that there is no interop on which order events will
fire after the sync XHR completes. Any blocked async XHR events
may fire after a setTimeout, rAf, or postMessage callback, for
instance. As such the polyfix only assures that any blocked
events call back in the order in which they were blocked.
