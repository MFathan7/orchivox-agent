export const LINUX_DESKTOP_HELPER = String.raw`
import sys,json,os,base64,signal,hashlib
request=json.loads(sys.stdin.read())
portal=None
connection=None
loop=None
cancelled=False

def stop(signum, frame):
    global cancelled
    cancelled=True
    if portal and connection:
        try: connection.call_sync('org.freedesktop.portal.Desktop',portal,'org.freedesktop.portal.Request','Close',None,None,Gio.DBusCallFlags.NO_AUTO_START,500,None)
        except Exception: pass
    if loop: loop.quit()
    raise InterruptedError('Desktop operation cancelled; an input may already have occurred.')
signal.signal(signal.SIGTERM,stop)

def fail(code,message):
    print(json.dumps({'ok':False,'code':code,'message':message}),flush=True)
    sys.exit(0)
try:
    import gi
    gi.require_version('Atspi','2.0')
    from gi.repository import Gio,GLib,Atspi
    import pyatspi
except (ImportError,ValueError):
    fail('desktop_dependency_missing','Linux desktop requires Python 3 with PyGObject, pyatspi and AT-SPI installed separately.')

try:
    Atspi.set_timeout(800,1000)
    connection=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    def owner(name):
        return connection.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',(name,)),None,Gio.DBusCallFlags.NO_AUTO_START,1000,None).unpack()[0]
    if request['action']=='status':
        value={'backend':'linux-atspi','session':os.environ.get('XDG_SESSION_TYPE','unknown'),'accessibilityBusRunning':owner('org.a11y.Bus'),'gnomeScreenshotRunning':owner('org.gnome.Shell.Screenshot'),'portalRunning':owner('org.freedesktop.portal.Desktop'),'input':'targeted accessibility actions/editable text only','globalKeyboard':False,'screenshot':'GNOME active-window capture requires OS permission; portal capture requires explicit user selection'}
        print(json.dumps({'ok':True,'value':value}),flush=True); sys.exit(0)
    def stamp(pid):
        try:
            with open('/proc/'+str(pid)+'/stat') as file: return file.read().rsplit(')',1)[1].split()[19]
        except Exception: return None
    def identity(node):
        app=node.getApplication()
        pid=int(node.get_process_id())
        return {'bus':app.app.bus_name,'path':node.path,'pid':pid,'start':stamp(pid),'name':'Protected entry' if node.getRole()==pyatspi.ROLE_PASSWORD_TEXT else (node.name or '')[:500],'role':int(node.getRole())}
    def same(left,right):
        return all(left.get(key)==right.get(key) for key in ['bus','path','pid','start','name','role'])
    def windows():
        desktop=pyatspi.Registry.getDesktop(0)
        results=[]; partial=desktop.childCount>200
        for appindex in range(min(desktop.childCount,200)):
            try:
                app=desktop.getChildAtIndex(appindex)
                if app.childCount>200: partial=True
                for index in range(min(app.childCount,200)):
                    node=app.getChildAtIndex(index)
                    if node.getRole() not in [pyatspi.ROLE_FRAME,pyatspi.ROLE_DIALOG,pyatspi.ROLE_WINDOW,pyatspi.ROLE_ALERT]: continue
                    if node.getState().contains(pyatspi.STATE_DEFUNCT): continue
                    results.append((node,identity(node)))
                    if len(results)>=request.get('maxWindows',30): return results,True
            except Exception: partial=True
        return results,partial
    if request['action']=='windows':
        found,partial=windows()
        result=[{'identity':item,'app':node.getApplication().name,'role':node.getRoleName()} for node,item in found]
        print(json.dumps({'ok':True,'value':{'windows':result,'partial':partial}}),flush=True); sys.exit(0)
    def selected():
        target=request.get('window')
        for node,item in windows()[0]:
            if same(item,target): return node
        fail('desktop_stale_window','Selected window identity changed or disappeared. List windows and select again.')
    window=selected()
    if request['action']=='verify':
        print(json.dumps({'ok':True,'value':{'window':request['window']}}),flush=True); sys.exit(0)
    def tree(root):
        queue=[(root,0)]
        visited=set(); items=[]; partial=False
        while queue and len(items)<request.get('maxNodes',300):
            node,depth=queue.pop(0)
            try:
                key=(node.app.bus_name,node.path)
                if key in visited or node.getState().contains(pyatspi.STATE_DEFUNCT): continue
                visited.add(key)
                actions=[]
                try:
                    action=node.queryAction()
                    actions=[{'index':i,'name':action.getName(i)} for i in range(min(action.nActions,20))]
                except Exception: pass
                items.append({'identity':identity(node),'role':node.getRoleName(),'actions':actions,'editable':bool(node.getState().contains(pyatspi.STATE_EDITABLE)),'depth':depth})
                if depth<request.get('maxDepth',8):
                    if node.childCount>200: partial=True
                    for index in range(min(node.childCount,200)): queue.append((node.getChildAtIndex(index),depth+1))
                elif node.childCount: partial=True
            except Exception: partial=True
        return items,bool(queue) or partial
    if request['action']=='observe':
        nodes,partial=tree(window)
        print(json.dumps({'ok':True,'value':{'window':request['window'],'nodes':nodes,'partial':partial}}),flush=True); sys.exit(0)
    if request['action']=='screenshot':
        if not window.getState().contains(pyatspi.STATE_ACTIVE): fail('desktop_window_not_active','Native window screenshot requires the selected window to already be active. No focus was changed.')
        result=connection.call_sync('org.gnome.Shell.Screenshot','/org/gnome/Shell/Screenshot','org.gnome.Shell.Screenshot','ScreenshotWindow',GLib.Variant('(bbbs)',(True,False,False,request['capturePath'])),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()
        if not result[0] or os.path.realpath(result[1])!=os.path.realpath(request['capturePath']): fail('desktop_capture_denied','GNOME did not provide the requested screenshot. Use explicit portal capture if supported.')
        if not selected().getState().contains(pyatspi.STATE_ACTIVE): fail('desktop_stale_window','Focus changed during capture; screenshot discarded.')
        path=request['capturePath']; scope='Selected active window; identity and active state rechecked.'
    elif request['action']=='capture':
        loop=GLib.MainLoop(); response={}; token='orchivox_'+os.urandom(12).hex()
        sender=connection.get_unique_name()[1:].replace('.','_')
        portal='/org/freedesktop/portal/desktop/request/'+sender+'/'+token
        def received(conn,sender_name,object_path,interface,signal_name,params,data):
            code,values=params.unpack(); response.update({'code':code,'values':values}); loop.quit()
        subscription=connection.signal_subscribe('org.freedesktop.portal.Desktop','org.freedesktop.portal.Request','Response',portal,None,Gio.DBusSignalFlags.NONE,received,None)
        try:
            returned=connection.call_sync('org.freedesktop.portal.Desktop','/org/freedesktop/portal/desktop','org.freedesktop.portal.Screenshot','Screenshot',GLib.Variant('(sa{sv})',('',{'handle_token':GLib.Variant('s',token),'interactive':GLib.Variant('b',True)})),None,Gio.DBusCallFlags.NONE,5000,None).unpack()[0]
            if returned!=portal: fail('desktop_portal_protocol','Portal returned an unexpected request identity.')
            heartbeat=GLib.timeout_add(50,lambda: True)
            if not response: loop.run()
            GLib.source_remove(heartbeat)
            if response.get('code')!=0: fail('desktop_capture_denied','Portal screenshot was cancelled or denied; no image was returned.')
            from urllib.parse import urlparse,unquote
            uri=urlparse(response['values'].get('uri',''))
            if uri.scheme!='file' or uri.netloc not in ['', 'localhost']: fail('desktop_portal_protocol','Portal returned a non-local screenshot URI.')
            path=unquote(uri.path); scope='User-selected portal capture; it is not verified as the selected accessibility window.'
        finally:
            connection.signal_unsubscribe(subscription)
            try: connection.call_sync('org.freedesktop.portal.Desktop',portal,'org.freedesktop.portal.Request','Close',None,None,Gio.DBusCallFlags.NO_AUTO_START,500,None)
            except Exception: pass
            portal=None
    else:
        nodes,_=tree(window)
        target=request.get('element')
        if not target or not any(same(item['identity'],target) for item in nodes): fail('desktop_stale_element','Element changed or is outside the selected window. Observe again.')
        queue=[window]; node=None; visited=set()
        while queue and len(visited)<request.get('maxNodes',300):
            current=queue.pop(0); key=(current.app.bus_name,current.path)
            if key in visited: continue
            visited.add(key)
            if same(identity(current),target): node=current; break
            for index in range(min(current.childCount,200)): queue.append(current.getChildAtIndex(index))
        if node is None: fail('desktop_stale_element','Target element disappeared.')
        selected()
        if node.getState().contains(pyatspi.STATE_DEFUNCT) or not node.getState().contains(pyatspi.STATE_SENSITIVE): fail('desktop_action_unavailable','Target element is not currently sensitive.')
        if request['action']=='invoke':
            action=node.queryAction(); index=request.get('actionIndex',0)
            if index<0 or index>=action.nActions: fail('desktop_action_unavailable','Requested action is unavailable for this element.')
            if action.getName(index)!=request.get('actionName'): fail('desktop_stale_element','Element action changed since observation.')
            if not action.doAction(index): fail('desktop_action_failed','Accessibility provider did not acknowledge the action.')
        elif request['action']=='set_text':
            if not node.getState().contains(pyatspi.STATE_EDITABLE): fail('desktop_action_unavailable','Target element is not editable.')
            if not node.queryEditableText().setTextContents(request.get('text','')): fail('desktop_action_failed','Accessibility provider did not acknowledge the text change.')
        else: fail('desktop_action_unavailable','Unsupported desktop action.')
        print(json.dumps({'ok':True,'value':{'window':request['window'],'action':request['action'],'target':target,'heldInput':False}}),flush=True); sys.exit(0)
    with open(path,'rb') as image: data=image.read(5*1024*1024+1)
    if len(data)>5*1024*1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'): fail('desktop_capture_invalid','Capture is not a PNG within the 5 MiB image limit.')
    print(json.dumps({'ok':True,'value':{'image':base64.b64encode(data).decode('ascii'),'scope':scope,'portal':request['action']=='capture'}}),flush=True)
except InterruptedError as error:
    fail('desktop_cancelled',str(error))
except Exception as error:
    name=type(error).__name__
    fail('desktop_permission_or_backend',name+': '+str(error)[:800])
`;
