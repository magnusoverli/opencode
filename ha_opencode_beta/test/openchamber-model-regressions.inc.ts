  test('HA new chat remembers the last-used model across storage hydration and later discovery', async () => {
    useSelectionStore.getState().saveSessionModelSelection('previous-session', 'live', 'live-model');
    useSelectionStore.setState({ lastUsedProvider: null });
    flushDeferredStorage();
    // Seed the persisted record independently, as a previous browser visit would.
    storage.set('selection-store', JSON.stringify({ version: 1, state: {
      lastUsedProvider: { providerID: 'live', modelID: 'live-model' },
      sessionModelSelections: [['previous-session', { providerId: 'live', modelId: 'live-model' }]],
    } }));
    await useSelectionStore.persist.rehydrate();
    useConfigStore.setState({
      providers: [provider('live'), provider('opencode', 'big-pickle')],
      agents: [testAgent('build')],
      settingsDefaultModel: 'opencode/big-pickle',
      settingsDefaultVariant: 'high',
    });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentProviderId).toBe('live');
    expect(useConfigStore.getState().currentModelId).toBe('live-model');
    expect(useConfigStore.getState().currentVariant).toBeUndefined();
    liveAgents = [{ name: 'build', mode: 'primary' }];
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    expect(useConfigStore.getState().currentModelId).toBe('live-model');
    expect(useSelectionStore.getState().getSessionModelSelection('previous-session')).toEqual({ providerId: 'live', modelId: 'live-model' });
  });

  test('HA new chat falls back when the remembered provider or model is gone', () => {
    useConfigStore.setState({ providers: [provider('live')], agents: [testAgent('build')], settingsDefaultModel: 'live/live-model' });
    for (const lastUsedProvider of [null, { providerID: 'removed', modelID: 'old' }, { providerID: 'live', modelID: 'removed-model' }]) {
      useSelectionStore.setState({ lastUsedProvider });
      useConfigStore.getState().applyDefaultModelAgentSelection();
      expect(useConfigStore.getState().currentProviderId).toBe('live');
      expect(useConfigStore.getState().currentModelId).toBe('live-model');
      expect(useConfigStore.getState().selectionSource).toBe('auto');
    }
  });

  test('HA remembered model wins for new chats without replacing the configured agent', () => {
    useConfigStore.setState({ providers: [provider('live'), provider('other')], agents: [testAgent('build'), testAgent('plan')] });
    useSelectionStore.setState({ lastUsedProvider: { providerID: 'live', modelID: 'live-model' } });
    useConfigStore.getState().applyDefaultModelAgentSelection({ projectDefaultAgent: 'plan', projectDefaultModel: 'other/other-model' });
    expect(useConfigStore.getState().currentAgentName).toBe('plan');
    expect(useConfigStore.getState().currentModelId).toBe('live-model');
  });
