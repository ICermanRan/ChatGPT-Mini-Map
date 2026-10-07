const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../conversation-model.js'), 'utf8'), context);

function parse(message) {
  return context.CGMapModel.parseConversation({
    current_node: 'node-1',
    mapping: { 'node-1': { parent: null, message: { id: 'message-1', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: message } } } }
  }).messages[0];
}

const imageQuestion = parse(['请比较两张图片', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://private' }]);
assert.equal(imageQuestion.bodyText, '请比较两张图片');
assert.equal(imageQuestion.text, '请比较两张图片\n[图片]');
assert.deepEqual(Array.from(imageQuestion.matchTexts), ['请比较两张图片', '请比较两张图片\n[图片]']);
assert.equal(imageQuestion.attachments[0].kind, 'image_asset_pointer');

const pdfQuestion = parse(['请分析这个 PDF 的主线', { content_type: 'file', name: 'report.pdf', file_id: 'private-id' }]);
assert.equal(pdfQuestion.bodyText, '请分析这个 PDF 的主线');
assert.equal(pdfQuestion.text, '请分析这个 PDF 的主线\n[文件：report.pdf]');
assert.equal(pdfQuestion.attachments[0].name, 'report.pdf');
assert.equal(Object.prototype.hasOwnProperty.call(pdfQuestion.attachments[0], 'file_id'), false);

const imageOnly = parse([{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://private' }]);
assert.equal(imageOnly.bodyText, '');
assert.equal(imageOnly.text, '[图片]');
assert.equal(imageOnly.matchTexts[0], '[图片]');

console.log('attachments-model: ok');
