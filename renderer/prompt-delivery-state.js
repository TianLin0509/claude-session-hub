'use strict';

function beginPromptDelivery(clientSubmissionId) {
  return { clientSubmissionId, status: 'pending', dismissed: false };
}

function applyPromptReceipt(state, receipt) {
  if (!state || !receipt || state.clientSubmissionId !== receipt.clientSubmissionId) return false;
  if (state.status === 'confirmed') return false;
  if (!['confirmed', 'unconfirmed', 'failed'].includes(receipt.status)) return false;
  state.status = receipt.status;
  return true;
}

module.exports = { beginPromptDelivery, applyPromptReceipt };
