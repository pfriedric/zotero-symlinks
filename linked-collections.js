/* global Zotero, Components, Services, LinkedCollections:writable */

LinkedCollections = {
    id: null,
    version: null,
    rootURI: null,
    _notifierID: null,
    _initialized: false,
    _syncTimer: null,
    _syncScheduled: false,
    _suppressedItems: new Map(), // sourceID -> Set(itemID) explicitly removed this session

    // ── Preferences helpers ──────────────────────────────────────────────

    PREF_KEY: "extensions.zotero.linkedcollections.links",

    getLinks() {
        try {
            const raw = Zotero.Prefs.get(this.PREF_KEY, true);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            Zotero.debug("[LinkedCollections] Error reading prefs: " + e);
        }
        return [];
    },

    saveLinks(links) {
        Zotero.Prefs.set(this.PREF_KEY, JSON.stringify(links), true);
    },

    addLink(sourceID, mirrorID, libraryID) {
        const links = this.getLinks();
        if (links.some(l => l.sourceID === sourceID && l.mirrorID === mirrorID)) return;
        links.push({ sourceID, mirrorID, libraryID });
        this.saveLinks(links);
    },

    removeLink(mirrorID) {
        let links = this.getLinks();
        links = links.filter(l => l.mirrorID !== mirrorID);
        this.saveLinks(links);
    },

    getSourceForMirror(mirrorID) {
        return this.getLinks().find(l => l.mirrorID === mirrorID) || null;
    },

    isLinkedCollection(collectionID) {
        const links = this.getLinks();
        return links.some(l => l.sourceID === collectionID || l.mirrorID === collectionID);
    },

    getLinkedGroup(collectionID) {
        const links = this.getLinks();
        const group = new Set();

        for (const link of links) {
            if (link.sourceID === collectionID) {
                group.add(link.sourceID);
                group.add(link.mirrorID);
            }
        }

        for (const link of links) {
            if (link.mirrorID === collectionID) {
                group.add(link.sourceID);
                group.add(link.mirrorID);
                for (const sibling of links) {
                    if (sibling.sourceID === link.sourceID) {
                        group.add(sibling.mirrorID);
                    }
                }
                break;
            }
        }

        return Array.from(group);
    },


    getCanonicalSourceID(collectionID) {
        const links = this.getLinks();
        for (const link of links) {
            if (link.sourceID === collectionID || link.mirrorID === collectionID) {
                return link.sourceID;
            }
        }
        return null;
    },

    getSuppressedSetForCollection(collectionID) {
        const sourceID = this.getCanonicalSourceID(collectionID);
        if (!sourceID) return null;
        if (!this._suppressedItems.has(sourceID)) {
            this._suppressedItems.set(sourceID, new Set());
        }
        return this._suppressedItems.get(sourceID);
    },

    suppressItemForGroup(collectionID, itemID) {
        const set = this.getSuppressedSetForCollection(collectionID);
        if (!set) return;
        set.add(itemID);
        Zotero.debug("[LinkedCollections] Suppressing item " + itemID +
            " for linked group rooted at " + this.getCanonicalSourceID(collectionID));
    },

    unsuppressItemForGroup(collectionID, itemID) {
        const sourceID = this.getCanonicalSourceID(collectionID);
        if (!sourceID) return;
        const set = this._suppressedItems.get(sourceID);
        if (!set) return;
        if (set.delete(itemID)) {
            Zotero.debug("[LinkedCollections] Unsuppressing item " + itemID +
                " for linked group rooted at " + sourceID);
        }
        if (set.size === 0) {
            this._suppressedItems.delete(sourceID);
        }
    },

    isSuppressedForCollection(collectionID, itemID) {
        const sourceID = this.getCanonicalSourceID(collectionID);
        if (!sourceID) return false;
        const set = this._suppressedItems.get(sourceID);
        return !!(set && set.has(itemID));
    },

    // ── Sync logic ───────────────────────────────────────────────────────
    //
    // Core design: sync ONLY ADDS items. It never removes automatically.
    //
    // Why: the previous symmetric add/remove propagation could race with
    // notifier echoes and transient collection state and, in the failure
    // mode reported by the user, end up deleting items from both source and
    // mirror collections.
    //
    // This version keeps automatic sync one-way-safe (union/add-only) and
    // provides an explicit item-menu command to remove selected items from
    // the entire linked group in one operation.

    _isSyncing: false,

    cancelScheduledSync() {
        this._syncScheduled = false;
        if (this._syncTimer) {
            try { this._syncTimer.cancel(); } catch (e) { /* */ }
            this._syncTimer = null;
        }
    },

    scheduleSync() {
        this.cancelScheduledSync();
        this._syncScheduled = true;
        this._syncTimer = Components.classes["@mozilla.org/timer;1"]
            .createInstance(Components.interfaces.nsITimer);
        this._syncTimer.initWithCallback({
            notify: () => {
                this._syncScheduled = false;
                this.doSync();
            }
        }, 500, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
    },

    async doSync() {
        if (this._isSyncing) return;
        this._isSyncing = true;

        try {
            const links = this.getLinks();
            if (links.length === 0) return;

            // Group links by source
            const sourceGroups = new Map();
            for (const link of links) {
                if (!sourceGroups.has(link.sourceID)) {
                    sourceGroups.set(link.sourceID, []);
                }
                sourceGroups.get(link.sourceID).push(link.mirrorID);
            }

            for (const [sourceID, mirrorIDs] of sourceGroups) {
                const sourceCol = Zotero.Collections.get(sourceID);
                if (!sourceCol) continue;

                // Compute the union of items across source and all mirrors,
                // excluding items explicitly removed via the safe-delete command
                // earlier in this Zotero session. This guards against stale
                // in-memory collection membership caches reintroducing removals.
                const suppressed = this._suppressedItems.get(sourceID) || new Set();
                const union = new Set();
                for (const itemID of sourceCol.getChildItems(true)) {
                    if (!suppressed.has(itemID)) union.add(itemID);
                }
                const mirrorCols = [];
                for (const mirrorID of mirrorIDs) {
                    const mirrorCol = Zotero.Collections.get(mirrorID);
                    if (!mirrorCol) continue;
                    mirrorCols.push({ id: mirrorID, col: mirrorCol });
                    for (const itemID of mirrorCol.getChildItems(true)) {
                        if (!suppressed.has(itemID)) union.add(itemID);
                    }
                }

                // Add missing items to source
                const sourceItems = new Set(sourceCol.getChildItems(true));
                for (const itemID of union) {
                    if (!sourceItems.has(itemID)) {
                        const item = Zotero.Items.get(itemID);
                        if (item) {
                            Zotero.debug("[LinkedCollections] Sync: adding " +
                                itemID + " to source " + sourceID);
                            item.addToCollection(sourceID);
                            await item.saveTx({ skipNotifier: true });
                        }
                    }
                }

                // Add missing items to each mirror
                for (const { id: mirrorID, col: mirrorCol } of mirrorCols) {
                    const mirrorItems = new Set(mirrorCol.getChildItems(true));
                    for (const itemID of union) {
                        if (!mirrorItems.has(itemID)) {
                            const item = Zotero.Items.get(itemID);
                            if (item) {
                                Zotero.debug("[LinkedCollections] Sync: adding " +
                                    itemID + " to mirror " + mirrorID);
                                item.addToCollection(mirrorID);
                                await item.saveTx({ skipNotifier: true });
                            }
                        }
                    }
                }
            }
        } catch (e) {
            Zotero.debug("[LinkedCollections] doSync error: " + e);
            Zotero.logError(e);
        } finally {
            this._isSyncing = false;
        }
    },

    async removeItemsFromLinkedGroup(collectionID, items) {
        const groupIDs = this.getLinkedGroup(collectionID);
        if (groupIDs.length < 2 || !items || !items.length) return 0;

        this.cancelScheduledSync();
        this._isSyncing = true;

        let removedCount = 0;
        try {
            for (const item of items) {
                if (!item) continue;

                this.suppressItemForGroup(collectionID, item.id);

                let memberships = [];
                try {
                    memberships = item.getCollections ? item.getCollections() : [];
                } catch (e) {
                    memberships = [];
                }
                const membershipSet = new Set(memberships);
                let changed = false;

                for (const targetCollectionID of groupIDs) {
                    if (membershipSet.has(targetCollectionID)) {
                        Zotero.debug("[LinkedCollections] Explicit remove: item " +
                            item.id + " from collection " + targetCollectionID);
                        item.removeFromCollection(targetCollectionID);
                        membershipSet.delete(targetCollectionID);
                        changed = true;
                    }
                }

                if (changed) {
                    await item.saveTx({ skipNotifier: true });
                    removedCount++;
                }
            }
        } catch (e) {
            Zotero.debug("[LinkedCollections] removeItemsFromLinkedGroup error: " + e);
            Zotero.logError(e);
        } finally {
            this._isSyncing = false;
        }

        return removedCount;
    },

    // ── Notifier ─────────────────────────────────────────────────────────

    _notifier: {
        notify: function (event, type, ids, extraData) {
            try {
                if (type === "collection-item") {
                    // Check if any affected collection is part of a link
                    const links = LinkedCollections.getLinks();
                    const linkedIDs = new Set();
                    for (const l of links) {
                        linkedIDs.add(l.sourceID);
                        linkedIDs.add(l.mirrorID);
                    }

                    let relevant = false;
                    for (const id of ids) {
                        const parts = id.split("-");
                        const colID = parseInt(parts[0], 10);
                        const itemID = parseInt(parts[1], 10);
                        if (linkedIDs.has(colID)) {
                            relevant = true;
                            if (event === "add" && Number.isInteger(itemID)) {
                                // A manual re-add should make the item eligible for sync again
                                LinkedCollections.unsuppressItemForGroup(colID, itemID);
                            }
                        }
                    }

                    if (relevant && !LinkedCollections._isSyncing) {
                        Zotero.debug("[LinkedCollections] Notifier: " + event +
                            " on linked collection, scheduling sync");
                        LinkedCollections.scheduleSync();
                    }
                }

                if (type === "collection" && event === "delete") {
                    for (const id of ids) {
                        const colID = parseInt(id, 10);
                        LinkedCollections.removeLink(colID);
                        let links = LinkedCollections.getLinks();
                        links = links.filter(l => l.sourceID !== colID);
                        LinkedCollections.saveLinks(links);
                    }
                }
            } catch (e) {
                Zotero.debug("[LinkedCollections] notifier error: " + e);
                Zotero.logError(e);
            }
        },
    },

    // ── UI: Context menu on collections/items ────────────────────────────

    _menuItems: [],

    addMenuItems(window) {
        const doc = window.document;

        const collectionMenu = doc.getElementById("zotero-collectionmenu");
        if (collectionMenu) {
            const sep = doc.createXULElement("menuseparator");
            sep.id = "linked-collections-separator";
            collectionMenu.appendChild(sep);
            this._menuItems.push(sep);

            const linkItem = doc.createXULElement("menuitem");
            linkItem.id = "linked-collections-link";
            linkItem.setAttribute("label", "Link Collection Here\u2026");
            linkItem.addEventListener("command", () => {
                try {
                    this.onLinkCollectionHere(window);
                } catch (e) {
                    Zotero.debug("[LinkedCollections] COMMAND ERROR: " + e);
                    Zotero.logError(e);
                }
            });
            collectionMenu.appendChild(linkItem);
            this._menuItems.push(linkItem);

            const unlinkItem = doc.createXULElement("menuitem");
            unlinkItem.id = "linked-collections-unlink";
            unlinkItem.setAttribute("label", "Unlink This Collection Mirror");
            unlinkItem.addEventListener("command", () => {
                try {
                    this.onUnlinkMirror(window);
                } catch (e) {
                    Zotero.debug("[LinkedCollections] COMMAND ERROR: " + e);
                    Zotero.logError(e);
                }
            });
            collectionMenu.appendChild(unlinkItem);
            this._menuItems.push(unlinkItem);

            collectionMenu.addEventListener("popupshowing", () => {
                const zp = Zotero.getActiveZoteroPane();
                const col = zp.getSelectedCollection();
                if (!col) {
                    linkItem.hidden = true;
                    unlinkItem.hidden = true;
                    sep.hidden = true;
                    return;
                }
                sep.hidden = false;
                linkItem.hidden = false;
                const link = this.getSourceForMirror(col.id);
                unlinkItem.hidden = !link;
            });
        }

        const itemMenu = doc.getElementById("zotero-itemmenu");
        if (itemMenu) {
            const itemSep = doc.createXULElement("menuseparator");
            itemSep.id = "linked-collections-item-separator";
            itemMenu.appendChild(itemSep);
            this._menuItems.push(itemSep);

            const removeLinkedItem = doc.createXULElement("menuitem");
            removeLinkedItem.id = "linked-collections-remove-linked-items";
            removeLinkedItem.setAttribute("label", "Remove Selected Item(s) from Linked Collections");
            removeLinkedItem.addEventListener("command", () => {
                try {
                    this.onRemoveSelectedItemsEverywhere(window);
                } catch (e) {
                    Zotero.debug("[LinkedCollections] COMMAND ERROR: " + e);
                    Zotero.logError(e);
                }
            });
            itemMenu.appendChild(removeLinkedItem);
            this._menuItems.push(removeLinkedItem);

            itemMenu.addEventListener("popupshowing", () => {
                const zp = Zotero.getActiveZoteroPane();
                const col = zp ? zp.getSelectedCollection() : null;
                const items = zp ? zp.getSelectedItems() : [];
                const show = !!(col && this.isLinkedCollection(col.id) && items && items.length);
                itemSep.hidden = !show;
                removeLinkedItem.hidden = !show;
            });
        }
    },

    removeMenuItems() {
        for (const el of this._menuItems) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }
        this._menuItems = [];
    },

    // ── Collection helpers ───────────────────────────────────────────────

    getAllCollections(libraryID) {
        const result = [];
        const topLevel = Zotero.Collections.getByLibrary(libraryID);
        const recurse = (collections) => {
            for (const col of collections) {
                result.push(col);
                const childIDs = col.getChildCollections(true);
                if (childIDs && childIDs.length > 0) {
                    const children = childIDs.map(id => Zotero.Collections.get(id)).filter(Boolean);
                    recurse(children);
                }
            }
        };
        recurse(topLevel);
        return result;
    },

    getCollectionPath(collection) {
        let path = collection.name;
        let parentID = collection.parentID;
        while (parentID) {
            const parent = Zotero.Collections.get(parentID);
            if (!parent) break;
            path = parent.name + " / " + path;
            parentID = parent.parentID;
        }
        return path;
    },

    // ── User actions ─────────────────────────────────────────────────────

    onLinkCollectionHere(window) {
        Zotero.debug("[LinkedCollections] onLinkCollectionHere called");

        const zp = Zotero.getActiveZoteroPane();
        const parentCol = zp.getSelectedCollection();
        if (!parentCol) return;

        const libraryID = parentCol.libraryID;
        const allCollections = this.getAllCollections(libraryID);
        const links = this.getLinks();
        const mirrorIDs = new Set(links.map(l => l.mirrorID));

        const choices = allCollections.filter(c => {
            if (c.id === parentCol.id) return false;
            if (mirrorIDs.has(c.id)) return false;
            return true;
        });

        if (choices.length === 0) {
            Services.prompt.alert(window, "Linked Collections",
                "No other collections available to link.");
            return;
        }

        const items = choices.map(c => ({
            id: c.id,
            label: this.getCollectionPath(c)
        }));
        items.sort((a, b) => a.label.localeCompare(b.label));

        const labels = items.map(i => i.label);
        const selected = { value: 0 };
        let ok = false;

        try {
            ok = Services.prompt.select(window, "Link Collection Here",
                "Select source collection to link under \"" + parentCol.name + "\":",
                labels, selected);
        } catch (e1) {
            try {
                const prompts = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                    .getService(Components.interfaces.nsIPromptService);
                ok = prompts.select(window, "Link Collection Here",
                    "Select source collection to link under \"" + parentCol.name + "\":",
                    labels.length, labels, selected);
            } catch (e2) {
                try {
                    const numberedList = items.map((item, i) =>
                        (i + 1) + ". " + item.label).join("\n");
                    const input = { value: "1" };
                    ok = Services.prompt.prompt(window, "Link Collection Here",
                        "Enter number:\n\n" + numberedList, input, null, { value: false });
                    if (ok) {
                        const idx = parseInt(input.value, 10) - 1;
                        if (idx >= 0 && idx < items.length) selected.value = idx;
                        else ok = false;
                    }
                } catch (e3) {
                    Zotero.logError(e3);
                    return;
                }
            }
        }

        if (!ok) return;

        const sourceCol = Zotero.Collections.get(items[selected.value].id);
        if (!sourceCol) return;

        Zotero.debug("[LinkedCollections] Linking: " + sourceCol.name +
            " under " + parentCol.name);

        // Create mirror and do initial sync
        (async () => {
            try {
                this._isSyncing = true;

                const mirror = new Zotero.Collection();
                mirror.libraryID = libraryID;
                mirror.name = "\u2937 " + sourceCol.name;
                mirror.parentID = parentCol.id;
                await mirror.saveTx();

                this.addLink(sourceCol.id, mirror.id, libraryID);

                // Copy items from source to mirror
                const sourceItemIDs = sourceCol.getChildItems(true);
                for (const itemID of sourceItemIDs) {
                    const item = Zotero.Items.get(itemID);
                    if (item) {
                        item.addToCollection(mirror.id);
                        await item.saveTx({ skipNotifier: true });
                    }
                }

                Zotero.debug("[LinkedCollections] Link complete! mirror=" +
                    mirror.id + ", copied " + sourceItemIDs.length + " items");
            } catch (e) {
                Zotero.debug("[LinkedCollections] Error creating mirror: " + e);
                Zotero.logError(e);
            } finally {
                this._isSyncing = false;
            }
        })();
    },

    async onRemoveSelectedItemsEverywhere(window) {
        const zp = Zotero.getActiveZoteroPane();
        const currentCol = zp ? zp.getSelectedCollection() : null;
        const selectedItems = zp ? zp.getSelectedItems() : [];

        if (!currentCol || !selectedItems || !selectedItems.length) return;

        const groupIDs = this.getLinkedGroup(currentCol.id);
        if (groupIDs.length < 2) {
            Services.prompt.alert(window, "Linked Collections",
                "This collection is not part of a linked collection group.");
            return;
        }

        const ok = Services.prompt.confirm(window, "Remove from Linked Collections",
            "Remove the selected " + selectedItems.length +
            (selectedItems.length === 1 ? " item" : " items") +
            " from all " + groupIDs.length +
            " linked collections in this group?\n\n" +
            "This is the safe delete path: it removes the item(s) everywhere in one step so they don't get re-added by sync.");
        if (!ok) return;

        const removedCount = await this.removeItemsFromLinkedGroup(currentCol.id, selectedItems);

        if (removedCount > 0) {
            Zotero.debug("[LinkedCollections] Explicit linked remove complete: " +
                removedCount + " item(s)");
        }
    },

    onUnlinkMirror(window) {
        const zp = Zotero.getActiveZoteroPane();
        const mirrorCol = zp ? zp.getSelectedCollection() : null;
        if (!mirrorCol) return;

        const link = this.getSourceForMirror(mirrorCol.id);
        if (!link) {
            Services.prompt.alert(window, "Linked Collections",
                "This collection is not a linked mirror.");
            return;
        }

        const ok = Services.prompt.confirm(window, "Unlink Mirror",
            "Unlink \"" + mirrorCol.name + "\"?\n\n" +
            "The mirror will become a regular collection.\n" +
            "Items in the source won't be affected.");
        if (!ok) return;

        this.removeLink(mirrorCol.id);

        (async () => {
            try {
                mirrorCol.name = mirrorCol.name.replace(/^\u2937\s*/, "");
                await mirrorCol.saveTx();
            } catch (e) {
                Zotero.logError(e);
            }
        })();
    },

    // ── Lifecycle ────────────────────────────────────────────────────────

    init({ id, version, rootURI }) {
        if (this._initialized) return;
        this.id = id;
        this.version = version;
        this.rootURI = rootURI;

        Zotero.debug("[LinkedCollections] Initializing v" + version);

        this._notifierID = Zotero.Notifier.registerObserver(this._notifier, [
            "collection-item",
            "collection",
        ]);

        this.addToAllWindows();
        Services.wm.addListener(this._windowListener);

        this._initialized = true;
        Zotero.debug("[LinkedCollections] Initialized");
    },

    shutdown() {
        Zotero.debug("[LinkedCollections] Shutting down");

        if (this._notifierID) {
            Zotero.Notifier.unregisterObserver(this._notifierID);
        }
        this.cancelScheduledSync();

        this.removeMenuItems();
        Services.wm.removeListener(this._windowListener);

        this._initialized = false;
    },

    addToAllWindows() {
        const windows = Services.wm.getEnumerator("navigator:browser");
        while (windows.hasMoreElements()) {
            const win = windows.getNext();
            if (win.ZoteroPane) {
                this.addMenuItems(win);
            }
        }
    },

    _windowListener: {
        onOpenWindow(xulWindow) {
            const domWindow = xulWindow
                .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                .getInterface(Components.interfaces.nsIDOMWindow);
            domWindow.addEventListener(
                "load",
                function () {
                    if (domWindow.ZoteroPane) {
                        LinkedCollections.addMenuItems(domWindow);
                    }
                },
                { once: true }
            );
        },
        onCloseWindow() {},
    },
};
