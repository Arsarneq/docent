# Reference Control Client

The Reference Control Client is a small implementation of the local process
side of the [Local Control Channel](../../docs/api/control-channel.md): a
Node.js module, with its own test suite, that a program on the same computer
builds on to pair with the Chrome extension's side panel and send it the
channel's commands. It has no entry point of its own to run. It exists as an
easy-to-read example for anyone writing their own local process, and it is
tested against a stand-in for the panel that follows the specification.

This module is part of the repository's
[reference implementations](../README.md).

> **This is a repository and testing artifact only.** The module lives under
> `reference-implementations/` (separate from `packages/`, which holds the
> shipped product) and is excluded from every release. It is never part of a
> product release and is not published to end users.

The [Local Control Channel](../../docs/api/control-channel.md) specification is
the authoritative contract: it describes what _any_ local process must do. This
document describes how _this_ module implements that contract, and links to the
specification rather than restating it.

---

## What it does

- **Listens where the panel dials, and only while it waits.** The panel is the
  WebSocket client and the local process the server. This module listens on
  `127.0.0.1` alone, on the one configured port, and holds that address and
  port itself ([LC-3](../../docs/api/control-channel.md#address)). It opens
  the listener when a pairing is asked for and closes it, together with any
  connection to it that never became the WebSocket, once one panel has paired
  or the attempt has ended. That no other process can bind the port while it is held is pinned
  by the suite on Linux, the platform CI runs; it is not verified on macOS or
  Windows.
- **Accepts the extension alone, and one connection.** A handshake whose
  `Origin` is not exactly `chrome-extension://<extension id>` is refused, as
  is a second connection while one is open. The id is the published
  extension's unless the caller configures another, as a build loaded from
  source needs.
- **Spends the attempt on its `pair` frame alone.** Until the client has sent
  that frame, nothing has been attempted
  ([LC-5](../../docs/api/control-channel.md#pairing)): a connection that ends,
  sends anything but a greeting of this protocol version, sends more than the
  pairing needs (16384 bytes before the panel's proof checks out), or does not
  greet within the greeting deadline is dropped, and the client goes on
  listening for the rest of the window. A connection greeting with another
  protocol version is closed with a protocol error; any connection still open
  when the window ends is closed normally. Going on listening helps only when
  the dropped connection was not the panel's: a panel whose connection ends
  turns Local control off (LC-5). From the `pair` frame on, whatever ends the
  connection ends the attempt.
- **Pairs in both directions.** It checks the shape of the code a person
  typed before it opens anything, proves the code over the panel's nonce, and
  checks the panel's proof over its own nonce, closing the connection when
  that proof is wrong ([LC-4](../../docs/api/control-channel.md#pairing)).
- **Sends commands and matches their results.** Each command gets an id of
  its own, commands may be sent behind one another, and each result is matched
  to its command by id ([LC-9](../../docs/api/control-channel.md#results)). A
  command frame longer than the panel reads is refused before it is sent
  ([LC-6](../../docs/api/control-channel.md#frames)).
- **Returns results as the panel sent them.** A result is handed back
  unchanged, its own `ok` and `error` included. The module reads a result's
  envelope only (its `type`, `id`, `ok` and `error`) and interprets nothing
  else: which commands exist, what their arguments mean and what a result says
  are the specification's and the caller's.

What it leaves to the program built on it: choosing which commands to send,
reading their results, and anything done with an export.

The pairing code passes through the caller, since a person types it there. The
module holds the code for the pairing attempt alone, writes nothing
to the console, and returns no value carrying the code or a proof.

A client pairs once. A code of the wrong shape is refused before anything
opens, and the same client can then be given the corrected code; after any
other outcome of `pair()`, a second call is refused and pairing again takes a
new client. Whether it also takes a new code is the panel's to say: the code
stays good only while Local control is still on in the panel. That holds when
no connection from the panel was accepted and then ended, as after a port in
use or a window that ended with no panel greeting. Once the panel's
connection has ended, for any reason, the panel has turned Local control off
and discarded the code (LC-5, LC-10), and turning it on again shows a new
one.

---

## Using it

Node.js 24 or later. Install the module's one dependency,
[`ws`](https://github.com/websockets/ws), from
`reference-implementations/control-client/`:

```bash
npm ci
```

Then, from a program of your own, either importing `client.js` by its path
or, from a sibling package that declares this one as a
`"docent-reference-control-client": "file:../control-client"` dependency, by
its name (npm links such a dependency rather than copying it, so `ws` is
still installed here, as above; the
[Reference MCP Server](../mcp-server/README.md) is built this way):

```js
import { createControlClient } from 'docent-reference-control-client';

const client = createControlClient({ port: 8765 });
const paired = await client.pair('7K3M-Q9XZ-4HTR-WB2N'); // the code the panel shows
if (!paired.ok) throw new Error(paired.message);

const outcome = await client.send('status');
if (outcome.ok) console.log(outcome.result); // the result frame as the panel sent it

await client.close();
```

The flow is the channel's own: a person turns the channel on in the side
panel, with the same port, reads the pairing code the panel then shows, and
gives it to the program, which calls `pair()` with it. The panel goes on
dialing the port until something answers (LC-3), so the client opens its
listener only then.

### Options

| Option              | Default                                                   | Meaning                                                                                                           |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `port`              | `8765`, the port the panel's turn-on control offers       | The port the person gave the panel, 1024 to 65535                                                                 |
| `extensionId`       | `odhpdgpoknpaakjdkdbjdgpljmpblijh`, the published id      | The extension whose `Origin` is accepted                                                                          |
| `pairTimeoutMs`     | `300000`, the span over which the panel dials (LC-3)      | How long `pair()` waits for a panel to connect and complete the pairing                                           |
| `maxFrameBytes`     | `67108864` (64 MiB)                                       | The largest frame read from the peer, from the first frame on; a larger one closes the connection. At least 16384 |
| `greetingTimeoutMs` | `10000`, the time the panel gives its peer to pair (LC-5) | How long an accepted connection has to greet before it is dropped                                                 |
| `randomBytes`       | `node:crypto`'s `randomBytes`                             | The random source of the local nonce, which must give exactly 16 bytes; a test supplies its own                   |

An option the module does not define, or a value out of range, throws when the
client is created: there is no option to listen on another address. The
specification bounds no frame the panel sends, an export included, so
`maxFrameBytes` is this module's own guard against a peer that sends without
end. It applies to every frame; before the panel's proof checks out, a
tighter bound of 16384 bytes in all applies beside it, which is why
`maxFrameBytes` may not be set below 16384.

### Surface

| Member              | Returns                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `pair(code)`        | `{ ok: true }` once paired                                                                |
| `send(name, args?)` | `{ ok: true, result }`, `result` the result frame as received; `args` left out sends none |
| `close()`           | Resolves once the connection has closed; safe to call more than once                      |
| `address()`         | `{ address, port, family }` while listening, `null` otherwise                             |
| `state`             | `idle`, `listening`, `paired` or `closed`                                                 |
| `closed`            | A promise of the failure that ended the client                                            |

Every way an operation fails is returned, never thrown, as
`{ ok: false, code, message }`. The code is one of the exported `FAILURES`
map's keys, and the message is that key's fixed text, written for a person to
read, with one sentence added when a paired client ends with commands waiting
(below):

| Code                        | When                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-code`              | The typed code is not 16 characters of the code alphabet, bare or in groups of four                                                                                                                       |
| `pairing-already-attempted` | `pair()` was already called on this client past the shape check; pairing again takes a new client (above)                                                                                                 |
| `port-in-use`               | Another process holds the port on `127.0.0.1`                                                                                                                                                             |
| `listen-failed`             | The port could not be listened on for another reason                                                                                                                                                      |
| `pairing-timeout`           | No panel paired within `pairTimeoutMs`                                                                                                                                                                    |
| `unsupported-version`       | No panel paired within `pairTimeoutMs`, and a connection dropped in that time greeted with another protocol version                                                                                       |
| `random-source-failed`      | The random source threw, or gave anything but 16 bytes, when a nonce was drawn; no `pair` frame was sent, and the connection that greeted was closed, which turns Local control off if it was the panel's |
| `pairing-refused`           | The peer closed the connection after the `pair` frame without its proof, as a panel does on a wrong code                                                                                                  |
| `panel-proof-mismatch`      | The peer's proof is wrong; the person should turn the channel off                                                                                                                                         |
| `protocol-error`            | After the `pair` frame, the peer sent a frame the specification does not allow, or a result for no command                                                                                                |
| `frame-too-large-received`  | After the `pair` frame, the peer sent more than the pairing needs; once paired, a frame over `maxFrameBytes`                                                                                              |
| `not-paired`                | A command was sent before a panel paired                                                                                                                                                                  |
| `invalid-command`           | The command could not be written as a command frame                                                                                                                                                       |
| `frame-too-large`           | The command frame is over the 16384 code units the panel reads                                                                                                                                            |
| `disconnected`              | The connection ended after pairing                                                                                                                                                                        |
| `closed`                    | The caller closed the client                                                                                                                                                                              |

Each failure that ends the client closes its connection and answers every
operation still waiting, and every `send()` after it, with the same failure.
One rule holds for every failure that ends a paired client, whatever its
code: a command that was still waiting may have run in the panel, which
finishes a command under way and sends no result once the channel is off
([LC-9](../../docs/api/control-channel.md#results)). So rather than sending
it again, pair again and read `status` to see where the panel stands. When
commands were waiting, the failure's message ends with a sentence saying so,
the same for every code, exported as `COMMANDS_MAY_HAVE_RUN`.

---

## Running the tests

From `reference-implementations/control-client/`, after `npm ci`:

```bash
npm test                 # both layers
npm run test:unit        # the pure parts: code shape, proofs, frames
npm run test:integration # the client against a stand-in for the panel
```

The unit layer checks the proofs against the specification's
[worked example](../../docs/api/control-channel.md#pairing). The integration
layer runs the client against a stand-in for the panel written in the tests,
which follows the panel's side of the specification and computes its proofs
independently: where and while the client listens, whom it accepts, which
connections it drops before the attempt, each pairing outcome, a round trip
for each command, the frames it refuses, and how the channel ends. Neither
layer runs the real panel. CI runs both layers in the `control-client-tests` job
([CI gates](../../docs/guides/ci.md#path-filtered-test-jobs)).

---

## Layout

| File                               | Role                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `client.js`                        | The listener, the pairing, and command and result matching  |
| `pairing.js`                       | Code shape, the nonce, and the proofs in both directions    |
| `frames.js`                        | Reading the panel's frames and writing the local process's  |
| `tests/unit/`                      | The pure parts, and the package's entry point               |
| `tests/integration/fake-panel.js`  | The stand-in for the panel the integration layer pairs with |
| `tests/integration/client.test.js` | The client against the stand-in                             |
