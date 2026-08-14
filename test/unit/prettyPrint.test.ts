import * as assert from 'node:assert';
import { prettyJson, prettyXml, prettyYaml } from '../../src/core/formats/prettyPrint';

suite('formats/prettyPrint', () => {
  test('JSON：壓縮字串重排為 2 空格縮排', () => {
    assert.strictEqual(
      prettyJson('{"b":1,"a":[1,2]}'),
      '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}',
    );
  });

  test('JSON：不合法就丟錯', () => {
    assert.throws(() => prettyJson('{"a":}'));
    assert.throws(() => prettyJson('{{ _.body }}'));
  });

  test('YAML：重排縮排並保留註解', () => {
    const out = prettyYaml('a:   1\nb:\n     - x\n     - y  # 註解');
    assert.strictEqual(out, 'a: 1\nb:\n  - x\n  - y # 註解\n');
  });

  test('YAML：不合法就丟錯', () => {
    assert.throws(() => prettyYaml('a: [1, 2'));
  });

  test('XML：巢狀縮排，純文字元素留在同行', () => {
    const out = prettyXml('<root><a>1</a><b><c x="1"/></b></root>');
    assert.strictEqual(out, '<root>\n  <a>1</a>\n  <b>\n    <c x="1"/>\n  </b>\n</root>');
  });

  test('XML：保留宣告、註解與 CDATA', () => {
    const out = prettyXml('<?xml version="1.0"?><r><!-- hi --><d><![CDATA[a<b]]></d></r>');
    assert.strictEqual(
      out,
      '<?xml version="1.0"?>\n<r>\n  <!-- hi -->\n  <d>\n    <![CDATA[a<b]]>\n  </d>\n</r>',
    );
  });

  test('XML：屬性值中的 > 不會被當成標籤結尾', () => {
    assert.strictEqual(prettyXml('<a t="x>y"></a>'), '<a t="x>y"></a>');
  });

  test('XML：標籤不成對或未關閉就丟錯', () => {
    assert.throws(() => prettyXml('<a><b></a></b>'), /不成對/);
    assert.throws(() => prettyXml('<a><b></b>'), /未關閉/);
    assert.throws(() => prettyXml('純文字'), /找不到任何 XML 元素/);
  });
});
