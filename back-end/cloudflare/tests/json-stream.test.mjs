import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectedJSON} from '../src/json-stream.mjs';
function parse(text, options, chunk=7) {
  const bytes=Buffer.from(text), parser=new ProjectedJSON(options);
  for(let i=0;i<bytes.length;i+=chunk)parser.write(bytes.subarray(i,i+chunk));
  return {value:parser.end(),parser,bytes};
}
test('streaming JSON handles Unicode, escaped keys and exact captured offsets',()=>{
  const text=' {"revision":0,"value": {"文":"测𠮷\\uD83D\\uDE00", "n":-2.5e+2,"x":[true,null,false,{}]},"deleted":false} ';
  const {value,parser,bytes}=parse(text);
  assert.deepEqual(value,JSON.parse(text));
  assert.deepEqual(JSON.parse(bytes.subarray(parser.captureStart,parser.captureEnd)),value.value);
});
test('reject duplicate keys, trailing JSON, nonfinite, invalid syntax and lone surrogates',()=>{
  for(const text of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{} {}','{"n":1e999}','[1,]','{"x":}','{"x":01}','{"x":"\\uD800"}','{"x":"\\uDC00"}','{"x":undefined}'])assert.throws(()=>parse(text),undefined,text);
});
test('canonical hash is insensitive to object order and formatting',()=>{
  assert.equal(parse('{"value":{"b":3,"a":["x",1]}}').parser.captureHash,parse('{"value":{ "a":["\\u0078",1.0],"b":3 }}').parser.captureHash);
  assert.notEqual(parse('{"value":[1,2]}').parser.captureHash,parse('{"value":[2,1]}').parser.captureHash);
});
test('prototype keys are inert and no prototype pollution occurs',()=>{
  const {value}=parse('{"__proto__":{"polluted":true},"constructor":2}');
  assert.equal({}.polluted,undefined); assert.equal(Object.hasOwn(value,'__proto__'),true);
});
test('huge opaque strings are projected without retaining content',()=>{
  const p=new ProjectedJSON({select:path=>path.join('.')!=='value.blob'});
  p.write(Buffer.from('{"value":{"id":"x","blob":"'));
  const chunk=Buffer.alloc(256*1024,97);for(let i=0;i<248;i++)p.write(chunk);
  p.write(Buffer.from('"},"revision":0}'));
  assert.deepEqual(p.end(),{value:{id:'x'},revision:0});
  assert.ok(p.captureEnd-p.captureStart>60*1024*1024);
});
