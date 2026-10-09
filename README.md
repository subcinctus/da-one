# da-one

## Plugins

**iphone-use** lets Claude Code operate your real iPhone, connected to your Mac with a USB cable: it opens apps,
reads the screen, taps, scrolls and types, collects lists and checks the results, and shows you a live picture of
the iPhone screen in your browser while it works. Passwords and codes always stay with you, and Claude never moves
money or does anything irreversible without your explicit go-ahead. Setup is guided by Claude and needs Xcode and
an Apple account (a free one works).

This repository is private: first sign this Mac in to GitHub with an account that may read it (for example run
`gh auth login` in Terminal and let it sign Git in too; `git ls-remote https://github.com/subcinctus/da-one` must
then work without a password). Until the plugin is merged into `main`, add the marketplace from its branch.
Install it from Claude Code:

```text
/plugin marketplace add subcinctus/da-one#claude/iphone-use-plugin
/plugin install iphone-use@da-one
```

On Claude Code 2.1.275 or later this also works in one step:

```text
/plugin install iphone-use --marketplace subcinctus/da-one#claude/iphone-use-plugin
```

After the merge, plain `subcinctus/da-one` works in both. Then restart Claude Code. Full guide:
[plugins/iphone-use/README.md](plugins/iphone-use/README.md).
