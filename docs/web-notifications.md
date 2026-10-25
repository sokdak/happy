# Browser notifications

On desktop Safari and Chrome, open **Settings → Account → Browser Notifications**
and select **Enable Browser Notifications**. Allow the browser's permission prompt.
The page must use HTTPS, or localhost during development. If permission was denied,
allow notifications for the site in browser settings and return to Happy. Also
allow the browser's notifications in the operating system's notification settings.

While the Happy tab is open and connected, task completion, permission requests,
and clarification questions produce system notifications when the tab is hidden
or its window is unfocused. The focused Happy tab uses its existing in-app
indicators. Clicking an alert focuses Happy and opens that session. A session's
latest alert replaces its previous alert.

This uses the existing live session-event stream, so no server changes or Expo
push tokens are needed. Closing, suspending, or disconnecting the tab stops
notifications; events missed while disconnected are not replayed as alerts.
Receiving alerts after closing the tab requires a separate Web Push integration.
