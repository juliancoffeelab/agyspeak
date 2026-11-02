"""Offline ACP peer used by backend tests; never contacts a model provider."""
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

settings = json.loads(Path(sys.argv[0]).with_suffix('.json').read_text())
trace = Path(sys.argv[0]).with_suffix('.jsonl')
authenticated = not settings.get('auth')
session = 'acp-chat'
options = [
    {'id': 'model', 'category': 'model', 'type': 'select', 'currentValue': 'other-model',
     'options': [{'value': 'gemini-3.8-flash', 'name': 'Flash'}, {'value': 'other-model', 'name': 'Other'}]},
    {'id': 'mode', 'category': 'mode', 'type': 'select', 'currentValue': 'auto_edit',
     'options': [{'value': v, 'name': v} for v in ['default', 'auto_edit', 'yolo']]},
    {'id': 'thinking_level', 'category': 'thought_level', 'type': 'select', 'currentValue': 'high',
     'options': [{'value': v, 'name': v} for v in ['low', 'medium', 'high']]},
]
options[0]['options'].extend({'value': value, 'name': value} for value in settings.get('extra_models', []))


def read():
    line = sys.stdin.readline()
    if not line:
        if settings.get('save_on_eof'):
            time.sleep(0.15)
            Path(sys.argv[0]).with_suffix('.saved').write_text('saved on orderly exit')
        sys.exit()
    message = json.loads(line)
    with trace.open('a') as out:
        out.write(json.dumps(message) + '\n')
    return message


def write(message):
    print(json.dumps({'jsonrpc': '2.0', **message}), flush=True)


def notify(update):
    write({'method': 'session/update', 'params': {'sessionId': session, 'update': update}})


while True:
    message = read()
    method, params = message['method'], message.get('params', {})
    result = {}
    if method == 'initialize':
        if settings.get('linger_child') or settings.get('save_child'):
            ready = Path(sys.argv[0]).with_suffix('.child-ready')
            saved = str(Path(sys.argv[0]).with_suffix('.child-saved')) if settings.get('save_child') else ''
            subprocess.Popen([sys.executable, '-c',
                'import os,signal,sys,time\nfrom pathlib import Path\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'parent = os.getppid()\nPath(sys.argv[1]).touch()\n'
                'if sys.argv[2]:\n'
                ' while os.getppid() == parent: time.sleep(0.01)\n'
                ' time.sleep(float(sys.argv[3]))\n Path(sys.argv[2]).write_text("child save complete")\n'
                'else: time.sleep(10)\n', str(ready), saved, str(settings.get('save_delay', 0.2))])
            while not ready.exists():
                time.sleep(0.01)
        print(settings.get('diagnostic', 'runtime starting'), file=sys.stderr, flush=True)
        result = {'protocolVersion': 1, 'agentCapabilities': {
            'loadSession': True, 'promptCapabilities': {'audio': settings.get('audio', True)},
            'sessionCapabilities': {} if settings.get('load') else {'resume': {}},
        }}
    elif method == 'authenticate':
        authenticated = True
    elif method == 'session/cancel':
        continue
    elif not authenticated:
        write({'id': message['id'], 'error': {'code': -32000, 'message': 'Authentication required'}})
        continue
    elif method in ['session/new', 'session/load', 'session/resume']:
        if method != 'session/new':
            session = params['sessionId']
            if settings.get('missing'):
                write({'id': message['id'], 'error': {'code': -32602, 'message': 'Session not found'}})
                continue
            if method == 'session/load':
                notify({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'OLD HISTORY'}})
        result = {'sessionId': session, 'configOptions': options}
    elif method == 'session/set_config_option':
        for option in options:
            if option['id'] == params['configId']:
                option['currentValue'] = params['value']
        result = {'configOptions': options}
    elif method == 'session/prompt':
        if settings.get('await_cancel'):
            cancellation = read()
            assert cancellation['method'] == 'session/cancel'
            write({'id': message['id'], 'result': {'stopReason': 'cancelled'}})
            continue
        if settings.get('hang'):
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(30)
        if settings.get('crash'):
            print('internal account info https://example.com/private', file=sys.stderr, flush=True)
            sys.exit(7)
        if settings.get('stream_forever'):
            while True:
                notify({'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'thinking'}})
                time.sleep(0.001)
        if settings.get('prompt_error'):
            write({'id': message['id'], 'error': {'code': -32603, 'message': 'Model error'}})
            continue
        if settings.get('permission'):
            if settings.get('partial_permission'):
                notify({'sessionUpdate': 'tool_call', 'toolCallId': 'call-1', 'title': 'Read recording', 'rawInput': {'Path': '/tmp/clip.wav'}})
            write({'id': 'permission-1', 'method': 'session/request_permission', 'params': {
                'sessionId': session, 'toolCall': {'toolCallId': 'call-1'} if settings.get('partial_permission') else {'toolCallId': 'call-1', 'title': 'Read recording'},
                'options': [{'optionId': 'yes', 'kind': 'allow_once', 'name': 'Allow once'},
                            {'optionId': 'no', 'kind': 'reject_once', 'name': 'Reject'}],
            }})
            read()
        if settings.get('unknown_request'):
            write({'id': 'unknown', 'method': 'fs/read_text_file', 'params': {}})
            read()
        print('diagnostic on stderr', file=sys.stderr, flush=True)
        notify({'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'PRIVATE THOUGHT'}})
        notify({'sessionUpdate': 'tool_call', 'toolCallId': 'call-1', 'title': 'read_file', 'rawInput': {'Path': '/tmp/clip.wav'}})
        for text in ['Hej', '!']:
            notify({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}})
        notify({'sessionUpdate': 'usage_update', 'used': 42, 'size': 1000})
        result = {'stopReason': 'end_turn'}
    else:
        raise AssertionError(method)
    write({'id': message['id'], 'result': result})
