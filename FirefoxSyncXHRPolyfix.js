(function() {
  "use strict";

  // This polyfix tries to mitigate a Firefox interop issue wherein
  // async XHR events and postMessages can fire before an ongoing
  // sync XHRs' events are handled (https://bugzil.la/697151).
  //
  // This is designed to only actually polyfix when necessary, and to
  // not use any features which would cause parsing errors on older
  // browsers, and to use as few modern JS-isms as possible so that it
  // is backward-compatible down to Firefox 6 (which has WeakMap).
  //
  // In a nutshell, the fix blocks async XHR events and postMessages
  // from firing while any sync XHR is ongoing, to match what other
  // browsers do.
  //
  // Note however that there is no interop on which order events will
  // fire after the sync XHR completes. Any blocked async XHR events
  // may fire after a setTimeout, rAf, or postMessage callback, for
  // instance. As such the polyfix only assures that any blocked
  // events call back in the order in which they were blocked.

  function polyfixNeeded() {
    var async = new XMLHttpRequest();
    try {
      async.open("get", "data:text/html,");
    } catch (_) {
      // IE11 doesn't allow data-URI XHRs, but
      // doesn't need the fix, either.
      return false;
    }
    var sync = new XMLHttpRequest();
    sync.open("get", "data:text/html,", false);
    var polyfixNeeded = false;
    async.onloadend = function() {
      polyfixNeeded = true;
    };
    async.send();
    sync.send();
    return polyfixNeeded;
  }

  if (!polyfixNeeded()) {
    return;
  }

  console.info("Applying work-around for https://bugzil.la/697151");

  var debug = window.FxSyncXHRPolyfixDebug || false;


  // We will be over-riding properties and functions on the
  // XMLHttpRequest prootype.

  var XHRProto = XMLHttpRequest.prototype;


  // We don't use ES6 Proxies for speed considerations.
  // (https://bugzilla.mozilla.org/show_bug.cgi?id=1172313)

  function findProperty(obj, name) {
    do {
      var prop = Object.getOwnPropertyDescriptor(obj, name);
      if (prop) {
        return prop;
      }
      obj = Object.getPrototypeOf(obj);
    } while (obj);
    return undefined;
  }


  // As we are going to delay calling handlers until well after
  // the time of the event, we must capture any state at the time
  // of the actual firing, like readyState, and later give that
  // correct value. We use WeakMaps for this because they were
  // supported in Firefox all the way to version 6 (insofar as
  // our purposes require), and this keeps the objects clean.

  var XHRStateSpoofs = new WeakMap();
  function spoofXHRState(xhr, values) {
    if (!XHRStateSpoofs.has(xhr)) {
      XHRStateSpoofs.set(xhr, {});
    }
    var currentSpoofs = XHRStateSpoofs.get(xhr);
    for (var name in values) {
      currentSpoofs[name] = values[name];
    }
  }


  // The most important state to track this way is readyState.

  var oldXHRRS = findProperty(XHRProto, "readyState").get;
  Object.defineProperty(XHRProto, "readyState", {
    get: function() {
      var override;
      if (XHRStateSpoofs.has(this)) {
        override = XHRStateSpoofs.get(this).readyState;
      }
      return override || oldXHRRS.call(this);
    }
  });


  // We also track the responseText's length at the time, so
  // we can deliver the correct responseText chunk during
  // progress events.

  var oldXHRRT = findProperty(XHRProto, "responseText").get;
  Object.defineProperty(XHRProto, "responseText", {
    get: function() {
      var text = oldXHRRT.call(this);
      if (XHRStateSpoofs.has(this)) {
        var length = XHRStateSpoofs.get(this).responseTextLength;
        if (length !== undefined) {
          if (length === text.length) {
            return text;
          }
          return text.substr(0, length);
        }
      }
      return text;
    }
  });


  // We must not allow send() to finish before we have fired the XHR's
  // readyState and other events.

  var openSyncXHRs = new WeakMap();
  var oldXHROpen = findProperty(XHRProto, "open").value;
  Object.defineProperty(XHRProto, "open", {
    value: function() {
      if (arguments.length > 2 && !arguments[2]) {
        openSyncXHRs.set(this);
      }
      return oldXHROpen.apply(this, arguments);
    }
  });

  var unblockingEvents = false;
  function unblockEventsIfNecessary() {
    if (mustUnblockEventsNow) {
      mustUnblockEventsNow = false;
      if (!unblockingEvents) {
        debug && debug("Unblocking", currentlyBlockedEvents.length, "events");
        unblockingEvents = true;
        while (currentlyBlockedEvents.length) {
          var evt = currentlyBlockedEvents.shift();
          debug && debug("Unblocking", evt.description || evt.name);
          evt();
        }
        unblockingEvents = true;
        currentlyBlockingOnSyncXHRs--;
        debug && debug("Events unblocked");
      }
    }
  }

  var currentlyBlockingOnSyncXHRs = 0;
  var mustUnblockEventsNow = false;
  var currentlyBlockedEvents;
  var oldXHRSend = findProperty(XHRProto, "send").value;
  Object.defineProperty(XHRProto, "send", {
    value: function() {
      if (openSyncXHRs.has(this)) {
        debug && debug("Sync XHR sending");

        // If we are starting another sync XHR as another
        // ended, we must ensure all blocked events from
        // the previous one are first handled. Note that
        // we also process them below just in case another
        // sync XHR doesn't happen for a while.
        unblockEventsIfNecessary();

        currentlyBlockingOnSyncXHRs++;
        currentlyBlockedEvents = [];
        var caughtException;
        try {
          oldXHRSend.call(this);
        } catch (exc) {
          caughtException = exc;
        }

        // If we're finally done with nested sync XHRs, we must
        // now process all events that were blocked in the
        // meantime.
        if (currentlyBlockingOnSyncXHRs === 1) {
          debug && debug("Sync XHR over");
          mustUnblockEventsNow = true;

          // Note that we must now delay an event-loop tick so
          // the send() call finishes before the blocked events
          // are handled. We must take very special care here,
          // as another sync XHR might begin before then, and
          // it must wait for the events to be processed before
          // it begins. As such, they may already be processed,
          // so unblockEvents guards against this race.
          Promise.resolve().then(unblockEventsIfNecessary);
        }

        if (caughtException) {
          throw caughtException;
        }
      } else {
        oldXHRSend.call(this, arguments);
      }
    }
  });


  // To match other browsers' event ordering, we must suspend
  // postMessage by an event-loop tick, then further delay it
  // if we have begun a sync XHR in the meantime.

  var oldPM = findProperty(window, "postMessage").value;
  Object.defineProperty(window, "postMessage", {
    value: function() {
      var args = arguments;
      var wnd = this;
      // delaying by a tick is easy, just resolve a Promise.
      Promise.resolve().then(function postMessage() {
        if (currentlyBlockingOnSyncXHRs) {
          debug && debug("Blocking postMessage");
          currentlyBlockedEvents.push(function postMessage() {
            oldPM.apply(wnd, args);
          });
        } else {
          debug && debug("Not blocking postMessage");
          oldPM.apply(wnd, args);
        }
      });
    }
  });


  // Now we want to wrap any event-handlers that users add to
  // XHRs, to delay them until any sync XHRs complete.

  function wrapHandler(handler, type) {
    return function() {
      var xhr = this;

      var args = arguments;
      var readyState = this.readyState;
      var responseType = this.responseType;

      var spoofs = {readyState: readyState};
      if (responseType === "" || responseType === "text") {
        if (readyState < 3) { // LOADING
          spoofs.responseTextLength = 0;
        } else if (args[0] && args[0].type === "progress") {
          spoofs.responseTextLength = args[0].loaded;
        } else {
          spoofs.responseTextLength = this.responseText.length;
        }
      }

      // If this event is for an async XHR, and we're currently
      // doing a sync XHR, then we block the event.
      var isSync = openSyncXHRs.has(this);
      var description = type + "(" + readyState + "," + isSync + ")";
      if (!isSync && currentlyBlockingOnSyncXHRs) {
        debug && debug("Blocking event", description);
        var wrappedHandler = function() {
          // We have to keep track of the relevant XHR state at the
          // time the handler was originally called, so that when
          // we finally fire the event, we can spoof that state.
          spoofXHRState(xhr, spoofs);
          var returnValue;
          if (handler.handleEvent) {
            returnValue = handler.handleEvent(args);
          }
          returnValue = handler.apply(this, args);
          spoofXHRState(xhr, {
            readyState: undefined,
            responseTextLength: undefined,
          });
          return returnValue;
        };
        wrappedHandler.description = description;
        currentlyBlockedEvents.push(wrappedHandler);
      } else {
        debug && debug("Not blocking event", description);
        if (handler.handleEvent) {
          return handler.handleEvent(args);
        }
        return handler.apply(this, args);
      }
    };
  }


  // Override addEventListener

  var registeredListeners = new WeakMap();
  var oldXHRAEL = XHRProto.addEventListener;
  var oldXHRREL = XHRProto.removeEventListener;
  XHRProto.addEventListener = function() {
    var type = arguments[0];
    var handler = arguments[1];
    var options = arguments[2];
    if (!handler) { // no handler, so this call will fizzle anyway
      return undefined;
    }
    var wrappedHandler;
    if (registeredListeners.has(handler)) {
      wrappedHandler = registeredListeners.get(handler);
    } else {
      wrappedHandler = wrapHandler(handler, type);
    }
    var returnValue = oldXHRAEL.call(this, type, wrappedHandler, options);
    registeredListeners.set(handler, wrappedHandler);
    return returnValue;
  };
  XHRProto.removeEventListener = function() {
    const type = arguments[0];
    const handler = arguments[1];
    const options = arguments[2];
    if (handler && registeredListeners.has(handler)) {
      var wrappedHandler = registeredListeners.get(handler);
      oldXHRREL.call(this, type, wrappedHandler, options);
    } else {
      oldXHRREL.apply(this, arguments);
    }
  };


  // Override each of the on* setters

  ["abort", "error", "load", "loadend", "loadstart",
   "progress", "readystatechange", "timeout"].forEach(function(evt) {
    var name = "on" + evt;
    var nativeSet = findProperty(XHRProto, name).set;
    var currentHandler;
    Object.defineProperty(XHRProto, name, {
      set: function(handler) {
        currentHandler = handler;
        nativeSet.call(this, wrapHandler(handler, name));
      },
      get: function() {
        return currentHandler;
      }
    });
  });
})();
