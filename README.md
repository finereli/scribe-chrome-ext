<img src="icons/icon128.png" width="96" alt="Scribe icon">

# Scribe for Chrome

A browser extension that transcribes your Google Meet and WhatsApp calls, so you can paste them into Claude or ChatGPT. No bot joins the call. You bring your own OpenAI key, and an hour-long call costs about 30 cents in transcription.

It's the browser version of [Scribe for Mac](https://github.com/finereli/scribe). The Mac app hears every app on your computer. This one runs anywhere Chrome or Chromium does, including Linux and Windows, and it hears a browser tab.

## Why

The usual way to get a transcript of a call is to invite a notetaker bot. That works when it's your meeting. When it's someone else's, the bot sits in the waiting room, and to get it in you have to ask the other person, mid-call, to let your robot record them. Most of the time you don't, and you end up with no transcript of the calls that mattered most.

Scribe listens from your side instead. Your microphone is one side of the call and the call's tab is the other, and nobody else needs to know or agree to anything.

## What it does

- **Notices calls.** When a Meet or WhatsApp Web call starts, Scribe shows a notification offering to record it. On any other site, open Scribe and press the red button, and it records that tab.
- **Knows who said what.** Your microphone is "Me" and the tab is "Them". Each side is recorded as its own stream, so when you talk over each other both of you still make it into the transcript. It picks up the names of the people on the call from the page.
- **Transcribes as you go.** Each stretch of speech goes to OpenAI a second or two after the speaker pauses. There's no language to choose, and a call that switches between languages comes out right.
- **Hands it to your AI.** The Claude and ChatGPT buttons copy the transcript and open the app. Paste, then ask what you want to know.
- **Keeps a file of every call.** Each finished call is saved as Markdown in `Downloads/Scribe/`, with the date, duration and people in front matter, ready for an AI agent or a notes app to read. Both sides of the audio are kept in the browser, and the download button saves them.
- **Doesn't lose calls.** Audio is written to disk every few seconds as the call goes. If the browser crashes or restarts mid-call, the call is closed with everything transcribed up to that point.

## Privacy

Scribe has no server. Your key stays in the browser and is sent only to OpenAI. Audio goes straight from your browser to OpenAI to be transcribed, and the recordings and transcripts stay on your computer.

## Install

Scribe isn't in the Chrome Web Store yet, so you load it as an unpacked extension.

1. Clone this repo, or download it as a zip and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. Scribe opens its setup page. Paste an OpenAI API key (you can make one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)), allow the microphone, and pin Scribe from the puzzle-piece menu.

It needs Chrome or Chromium 127 or later. `Alt+Shift+S` opens Scribe from any tab.

The manifest has a fixed key, so the extension keeps the same ID wherever the folder lives, and your calls and settings survive moving it. On Chromium you can also load it at every launch with `--load-extension=/path/to/scribe-chrome-ext`.

## How it works

There's no build step. It's plain JavaScript, small enough to read before you trust it with your audio.

- `background.js` is the service worker. It notices calls, starts and stops the recorder, and keeps the current call in storage.
- `offscreen.js` is the recorder. It captures the tab and the microphone, cuts each side into turns at the pauses, and sends them to OpenAI. It lives in an offscreen document because the popup closes whenever you click away.
- `content/` detects when a Meet or WhatsApp call starts and ends, and who's on it.
- `popup.js` shows the transcript as it grows, past calls and settings.
- `lib/` has the turn detection, the OpenAI queue, the IndexedDB store and the Markdown export.

## License

MIT
