function createQuitGuard({ flush, ask, retryQuit }) {
  let allowUnsavedQuit = false;
  let promptOpen = false;

  return function guardQuit(event) {
    if (allowUnsavedQuit) return true;
    if (promptOpen) {
      event?.preventDefault?.();
      return false;
    }

    let outcome;
    try {
      outcome = flush();
    } catch (error) {
      outcome = {
        ok: false,
        kind: 'integrity',
        message: error?.message || 'Nūs could not save your latest changes.',
      };
    }

    if (outcome?.ok) return true;

    event?.preventDefault?.();
    promptOpen = true;
    Promise.resolve(ask(outcome))
      .then((decision) => {
        promptOpen = false;
        if (decision === 'quit_without_saving') {
          allowUnsavedQuit = true;
          retryQuit();
        }
      })
      .catch(() => { promptOpen = false; });
    return false;
  };
}

module.exports = { createQuitGuard };
