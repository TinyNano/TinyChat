# -*- coding: utf-8 -*-
NL13 = bytes([13, 10])   # CRLF
NL = bytes([10])         # LF

# 1) app.js 轨道点击改 instant
p = 'static/js/app.js'
data = open(p, 'rb').read()
old = (b"    area.scrollTop = ratio * (area.scrollHeight - area.clientHeight);" + NL13
       + b"    state._followStream = true;" + NL13)
if data.count(old) != 1:
    old = old.replace(NL13, NL)
assert data.count(old) == 1, 'track'
new = (b"    // chat-area \xe7\x9a\x84 scroll-behavior \xe6\x98\xaf smooth,\xe7\x9b\xb4\xe6\x8e\xa5\xe8\xb5\x8b\xe5\x80\xbc\xe4\xbc\x9a\xe5\x8f\x98\xe6\x88\x90\xe4\xb8\x80\xe6\xae\xb5\xe8\xbf\xbd\xe8\xb5\xb6\xe5\x8a\xa8\xe7\x94\xbb;" + NL13
       + b"    // \xe7\x82\xb9\xe5\x87\xbb\xe8\xb7\xb3\xe6\xae\xb5\xe8\xa6\x81\xe5\x8d\xb3\xe6\x97\xb6\xe8\x90\xbd\xe5\x9c\xb0,instant \xe8\xa6\x86\xe7\x9b\x96 CSS \xe7\x9a\x84 smooth" + NL13
       + b"    area.scrollTo({ top: ratio * (area.scrollHeight - area.clientHeight), behavior: 'instant' });" + NL13)
data = data.replace(old, new)
open(p, 'wb').write(data)

# 2) notes.js 补回 seenOut
p = 'static/js/notes.js'
data = open(p, 'rb').read()
NLn = NL13 if b'\r\n' in data else NL
old = (b"  const seenOut = {};" + NLn + b"  String(note.content || '').replace(LINK_RE, (m, inner) => {")
assert data.count(old) == 1, 'seenout'
# 实际情况:seenOut 声明被我删掉了,出链部分还在用 —— 在出链扫描前补回声明
old2 = (b"  const seenOut = {};" + NLn)  # 若声明其实还在就先看计数
# 直接看:出链部分前面一行是什么
i = data.find(b"String(note.content || '').replace(LINK_RE, (m, inner) => {")
seg = data[i - 120:i]
print('context:', seg[-60:])
