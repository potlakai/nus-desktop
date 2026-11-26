const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke('home:' + name, ...args);
contextBridge.exposeInMainWorld('home', {
  status: () => invoke('status'), settingsGet: () => invoke('settings:get'), settingsSet: p => invoke('settings:set',p), publikChoice: c => invoke('publik:choice',c), publikWho: () => invoke('publik:who'), publikSignOut: () => invoke('publik:signout'),
  keysTest: which => invoke('keys:test', which), statsSource: source => invoke('stats:source', source), myNus: () => invoke('my-nus'), shareCard: dataUrl => invoke('share-card', dataUrl),
  sessions: () => invoke('sessions'), messages: id => invoke('messages',id), search: q => invoke('search',q), exportSession: id => invoke('session:export',id),
  keeps: () => invoke('keeps:list'), forgetKeep: key => invoke('keeps:forget',key), routines: () => invoke('routines:list'), deleteRoutine: at => invoke('routines:delete',at), notes: () => invoke('notes:list'),
  folders: () => invoke('folders:list'), addFolder: () => invoke('folders:add'), removeFolder: id => invoke('folders:remove',id), toggleFolder: (id,v) => invoke('folders:toggle',id,v), reindexFolder: id => invoke('folders:reindex',id),
  intents: () => invoke('intents'), setPtt: v => invoke('ptt:set',v), openExternal: url => invoke('open-external',url),
  mapGet: () => invoke('map:get'), mapSet: (key,v) => invoke('map:set',key,v), control: action => invoke('control',action),
  memoryPanel: () => invoke('memory:panel'), memoryAdd: (key,v) => invoke('memory:add',key,v), memoryRemove: id => invoke('memory:remove',id),
  memoryImport: (source,text) => invoke('memory:import',source,text), memoryForgetSource: source => invoke('memory:forget-source',source), memoryPrompt: () => invoke('memory:prompt'),
  recallPanel: () => invoke('recall:panel'), recallVault: () => invoke('recall:vault'), recallVaultClear: () => invoke('recall:vault-clear'),
  recallImportFolder: () => invoke('recall:import-folder'), recallImportFile: () => invoke('recall:import-file'), recallForget: () => invoke('recall:forget'), tasksDelete: () => invoke('tasks:delete'),
  recallTopics: () => invoke('recall:topics'), recallWatch: on => invoke('recall:watch', on), recallWatchFolder: clear => invoke('recall:watch-folder', clear),
  feedbackSend: p => invoke('feedback:send', p), feedbackStatus: () => invoke('feedback:status'),
  contactStatus: () => invoke('contact:status'), contactGive: email => invoke('contact:give', email), contactDecline: () => invoke('contact:decline'),
  accountStatus: () => invoke('account:status'), accountSignIn: () => invoke('account:signin'), accountCancel: () => invoke('account:cancel'),
  accountSignOut: () => invoke('account:signout'), accountDismiss: () => invoke('account:dismiss'),
  accountUnlink: () => invoke('account:unlink'), accountLink: () => invoke('account:link'), accountDelete: () => invoke('account:delete'),
  accountSync: on => invoke('account:sync', on), accountSyncNow: () => invoke('account:sync-now'),
  updateCheck: () => invoke('update:check'), updateDismiss: () => invoke('update:dismiss'), updateRun: () => invoke('update:run'),
  voiceStatus: () => invoke('voice:status'), voiceInstall: name => invoke('voice:install', name),
  speechStatus: () => invoke('speech:status'), speechInstall: () => invoke('speech:install'),
  tasksList: () => invoke('tasks:list'), taskAction: p => invoke('task:action', p), projectContinue: id => invoke('project:continue', id), knotWord: () => invoke('knot:word'),
  tourState: () => invoke('tour:state'), tourStart: () => invoke('tour:start'), tourSkip: () => invoke('tour:skip'),
  reminders: () => invoke('reminders:list'), removeReminder: id => invoke('reminders:remove', id), activity: () => invoke('activity'),
  on: (channel, cb) => { if (!['home:state','home:indexing','home:save-state','home:view','home:voice','home:speech','home:recall','home:tour','home:settings','home:tasks','home:knot','home:account','home:contact','home:update','home:reminders'].includes(channel)) return; const listener=(_e,value)=>cb(value); ipcRenderer.on(channel,listener); return () => ipcRenderer.removeListener(channel,listener); }
});
