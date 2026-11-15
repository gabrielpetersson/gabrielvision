# Gabriel Singing Contest

A karaoke singing game in the browser: sing into your mic, a comet traces your pitch over scrolling
note bars, and you score more the closer you stay to each note. A speech model running in your
browser checks that you sing the words. Three difficulties and a vocal coach report.

Play: https://gabrielpetersson.github.io/gabrielvision/ (Chrome, Edge, Firefox or Safari; headphones recommended)

**Sing your own songs.** Add any audio or video file and the game makes it singable: it separates the voice
from the music, writes down the words and finds the notes, all on your device (needs a browser with WebGPU,
such as Chrome or Edge on a laptop). Paste the lyrics for exact lines. Uploaded songs stay in your browser.

**Sing with friends.** Press "Sing with friends", copy the invite link and send it. Everyone sings on their own
device, the song starts at the same moment for all, and scores show live. Pick "Take turns" for two lines each.
Songs anyone uploaded show up for the whole room: pick one and it is sent to everyone who doesn't have it yet,
and stays in their library afterwards.

**Take turns on one device.** Under "Sing alone", pass one mic around: each singer gets two lines, then the next one is up (up to six singers).
Or sing together, two singers on two mics.

Built-in songs are public-domain compositions (Twinkle, Twinkle, Little Star; Happy Birthday to You;
Amazing Grace) in new arrangements made for this game. Instruments use the GeneralUser GS soundfont.

Models and libraries: voice separation with MDX-Net "Kim Vocal 2" from Ultimate Vocal Remover (MIT) on
ONNX Runtime Web; lyrics with Whisper base via transformers.js; other file formats with ffmpeg.wasm.
