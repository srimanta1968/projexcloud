# @projexlight/voice-widget

`TalkToAgent`: an embeddable React widget for talking to a ProjexCloud AI voice agent through a
test session (a draft agent works). It asks for the microphone first, then connects to the
session's LiveKit room, and shows every state: connecting, connected, waiting for the agent,
muted, ended, and a blocked or missing microphone with how to fix it.

```tsx
import { TalkToAgent } from '@projexlight/voice-widget';

<TalkToAgent
  title="Scheduling assistant"
  startSession={() => startTestSessionOnMyBackend(agentId)}   // -> { call_id, livekit_url, token }
/>
```

Start the session on your backend (`POST /api/voice-agent/test-sessions`, e.g. with
`@projexlight/voice-client`), so your credential never reaches the browser; only the room
URL and room token do.

The root element carries `data-state` (`idle`, `requesting_mic`, `mic_denied`, `no_microphone`,
`connecting`, `connected`, `ended`, `error`) and every control a `data-testid`, for styling and
tests. For a custom UI use the headless `useTalkToAgent(startSession)` hook, or the pure
`widgetReducer` state machine.
