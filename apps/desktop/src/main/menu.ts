import { ApplicationMenu } from 'electrobun/main';

export function installMenu(onAction: (action: string) => void): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: 'Neon Video Studio',
      submenu: [{ label: 'About Neon Video Studio', action: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', action: 'project:new', accelerator: 'n' },
        { label: 'Open Project…', action: 'project:open', accelerator: 'o' },
        { type: 'separator' },
        { label: 'Save', action: 'project:save', accelerator: 's' },
        { label: 'Save As…', action: 'project:save-as' },
        { type: 'separator' },
        { label: 'Import Media…', action: 'assets:import', accelerator: 'i' },
        { label: 'Render…', action: 'render:open', accelerator: 'e' },
        { type: 'separator' },
        { label: 'Reveal Project Folder', action: 'project:reveal' },
        { label: 'Open Renders Folder', action: 'renders:reveal' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', action: 'edit:undo', accelerator: 'z' },
        { label: 'Redo', action: 'edit:redo', accelerator: 'Z' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Split at Playhead', action: 'timeline:split', accelerator: 'k' },
        { label: 'Delete Selection', action: 'timeline:delete' },
      ],
    },
    {
      label: 'Room',
      submenu: [
        { label: 'Host Room', action: 'room:host' },
        { label: 'Join Room…', action: 'room:join' },
        { label: 'Leave Room', action: 'room:leave' },
      ],
    },
    {
      label: 'View',
      submenu: [{ label: 'Toggle Full Screen', action: 'view:fullscreen' }, { label: 'Zoom Timeline In', action: 'view:zoom-in', accelerator: '=' }, { label: 'Zoom Timeline Out', action: 'view:zoom-out', accelerator: '-' }],
    },
    {
      label: 'Help',
      submenu: [{ label: 'CLI: neon-cli --help', action: 'help:cli' }, { label: 'Remotion licensing', action: 'help:remotion-license' }],
    },
  ]);

  ApplicationMenu.on('application-menu-clicked', (event: unknown) => {
    const data = (event as { data?: { action?: string } } | undefined)?.data ?? (event as { action?: string });
    const action = typeof data?.action === 'string' ? data.action : undefined;
    if (action) onAction(action);
  });
}
