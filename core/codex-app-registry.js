'use strict';

const clients = new Map();

function setClient(sessionId, client) {
  if (sessionId && client) clients.set(sessionId, client);
}

function getClient(sessionId) {
  return clients.get(sessionId) || null;
}

function deleteClient(sessionId) {
  clients.delete(sessionId);
}

function hasClient(sessionId) {
  return clients.has(sessionId);
}

module.exports = {
  setClient,
  getClient,
  deleteClient,
  hasClient,
};
