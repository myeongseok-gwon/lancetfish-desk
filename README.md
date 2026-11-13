# Lancetfish

A local research desk for macOS. It keeps your papers, your highlights and the
conversations you have about them with AI apps in one place, and it runs
entirely on your own Mac.

Lancetfish is a small web app that you start on your computer and open in your
browser at `http://127.0.0.1:4848`. There is no account and no server other than
the one on your machine. What does leave your Mac is listed, in full, under
“Your data and your privacy”.

> **Status: early source release.** It works, and the author uses it daily, but
> setup still takes a few minutes in Terminal. See “What is not included” below.

## What it does

- **Library.** One search box over your papers, your highlights, your notes and
  your AI conversations, grouped by paper. Each paper has a page that gathers
  everything about it.
- **Inbox.** Drop PDFs into a folder. Lancetfish works out which paper each one
  is from its DOI or arXiv number, asks you to confirm, then files it as
  `Surname Year Title.pdf` and clears it from the inbox.
- **Reader.** Read a PDF in the browser with highlights in three colors, margin
  notes, a pen, a table of contents and a find bar. Your annotations are saved
  as plain JSON on your disk.
- **Highlight anywhere.** Drag over text on any page to highlight it. Option+1,
  Option+2 and Option+3 choose yellow, green or pink.
- **Science.** If you use Claude Science, its projects, literature reviews and
  evidence tables are rendered on the page. A citation of a paper that is
  already in your library links to your copy.
- **AI conversations, linked to papers.** If you use Claude Code or Codex,
  Lancetfish reads their local history (read-only) and shows each conversation
  on the page of the paper it was about. For ChatGPT and Claude on the web you
  can paste a conversation link onto a paper.
- **Focus clock.** A 50 minute block clock with a score, for the side screen.
  While a block runs it checks every few seconds whether you are at the
  keyboard and which app is in front, and keeps those samples on your Mac.
- **Obsidian.** Write paper notes, with your highlights, into a vault you
  choose. Notes you wrote yourself are never edited.

## Set it up

You need a Mac and about ten minutes.

1. **Install Node.js 25 or newer** from [nodejs.org](https://nodejs.org/).
2. **Install Poppler**, which the inbox uses to read the first page of a PDF. With
   [Homebrew](https://brew.sh/): `brew install poppler`. Without it the rest of
   Lancetfish works, but the inbox can only recognize a paper from its file name.
3. **Download this repository.** Press the green **Code** button on GitHub, then
   **Download ZIP**, and unzip it somewhere permanent such as your Documents
   folder. If you use git: `git clone` it instead.
4. **Double-click `Start.command`.** If macOS refuses because the file was
   downloaded, right-click it, choose **Open**, then **Open** again. A Terminal
   window appears and your browser opens the Settings page.
5. **Choose your folders in Settings**: where your PDFs live, which folder is
   your paper inbox, and which AI apps you use. Every app starts switched off;
   Lancetfish reads nothing until you turn it on.
6. Put a PDF in your inbox folder, open **Inbox**, and press **Process inbox**.

Keep the Terminal window open while you use Lancetfish. Press Control-C in it to
stop. To start again, double-click `Start.command`.

### Python, for the reader

The reader saves your highlights through a small Python helper, so it needs
Python 3.11 or newer. Check with `python3 --version` in Terminal. If macOS
offers to install the command line developer tools, accept; that provides it.

To also get a paper’s table of contents and selectable text on scanned pages,
install two packages. In Terminal, from the folder you unzipped:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

`Start.command` finds this environment by itself the next time you open it.

### Optional: asking Claude to identify a paper

When a PDF has no DOI, the inbox can ask Claude to read its first page. This
uses the [Claude Code](https://claude.com/claude-code) command line tool on your
own subscription, and only when you press **Read it** or **Read next 5**. The
text of the PDF’s first pages (up to about 7,000 characters) is sent to Claude
for that purpose. Without Claude Code those buttons do nothing useful;
everything else works.

## Your data and your privacy

- **Everything stays on your Mac.** The server listens on `127.0.0.1` only, so
  other computers on your network cannot reach it.
- **Where your data lives.** Everything Lancetfish writes for itself is in
  `~/Library/Application Support/LancetfishV2`: your settings, the search
  index, highlights and reader annotations, focus samples, the opening text of
  each inbox PDF, and, for each AI app you switch on, a searchable copy of its
  conversations (for Claude Science, a copy of its database). Filed PDFs go to
  the `filed` folder inside the library folder you choose, and the original is
  removed from the inbox once the copy is verified. Paper notes go into your
  Obsidian vault if you connect one. Back these up as you would any documents.
- **What it reads.** Only the folders you choose, and only the AI app histories
  you switch on; every app is off until you turn it on. Those histories are
  opened read-only and never modified. The inbox reads its own folder and
  nothing else, unless you add more folders yourself in the settings file. To
  offer choices on the Settings page, Lancetfish looks up the names of your
  Obsidian vaults and whether Claude Science is installed.
- **What leaves your machine.** Two things, and nothing else. Paper lookups go
  to Crossref, arXiv, OpenAlex and doi.org, carrying a DOI, an arXiv number or
  a title, to fetch citation details. And if you press **Read it** or **Read
  next 5** in the inbox, the opening text of that PDF goes to Claude through
  your own Claude Code. There are no analytics and no telemetry.
- **Never commit your data.** If you keep a clone of this repository, the
  `.gitignore` already excludes data folders and PDFs. Leave it that way.

## What is not included

The author’s own setup has more than this release does. These parts depend on
code that has not been prepared for publication, and their buttons do not appear
here:

- the slide editor
- the course and meeting schedule with recording and transcripts
- Translate and Study on a text selection
- the chat panel inside the reader

It is also macOS only. The clipboard hand-off, app detection and Finder
integration have not been written for Windows or Linux.

## Check that it works

```sh
node tests/v2_science_markdown_check.mjs
```

## Third-party software

The reader displays PDFs with [PDF.js](https://mozilla.github.io/pdf.js/) by
Mozilla, under the Apache License 2.0. The library files are the standard build;
`textlayer.css` is a short extract of its viewer stylesheet. The license is in
`apps/hub/hub/static/vendor/pdfjs/`.

## License

No license has been chosen yet. Until one is added, you are welcome to download
and run Lancetfish for your own use, but the code may not be redistributed.
