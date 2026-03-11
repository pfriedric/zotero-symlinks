/* eslint-disable no-unused-vars */
var LinkedCollections;

function startup({ id, version, rootURI }, reason) {
    Services.scriptloader.loadSubScript(rootURI + "linked-collections.js");
    LinkedCollections.init({ id, version, rootURI });
}

function shutdown({ id, version, rootURI }, reason) {
    LinkedCollections.shutdown();
    LinkedCollections = undefined;
}

function install({ id, version, rootURI }, reason) {}

function uninstall({ id, version, rootURI }, reason) {}
