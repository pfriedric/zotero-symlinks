# Zotero Linked Collections

Create linked Zotero collections that appear in multiple places and stay in sync.

**NOTE: this is highly experimental! Back up your library before using it.** 

## What it does

This plugin lets you create a **mirror collection** under another parent collection. The linked collections share the same items:

- adding an item to the source or any mirror syncs it to the whole linked group
- unlinking removes the mirror relationship without deleting items
- explicit deletion is supported through a safe context-menu action:
  `Remove Selected Item(s) from Linked Collections`

## Installation

Get the current release `.xpi`, install via Zotero->tools->plugins.

**Optionally:** Clone or download the repo. Then, on macOS or Linux:

```bash
bash scripts/package.sh
```

That creates a `.xpi` file in `dist/`. Install this via Zotero->tools->plugins.

## Usage

### Create a linked collection

1. Right-click the collection that should contain the mirror.
2. Choose **Link Collection Here…**
3. Select the source collection.

### Remove items from all linked copies

1. Open any collection in the linked group.
2. Select one or more items.
3. Right-click and choose **Remove Selected Item(s) from Linked Collections**.

## License

Apache 2.0
