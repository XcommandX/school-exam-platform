'use strict';
window.SATShortcuts=Object.freeze([
 {key:'ArrowLeft',label:'←',description:'Previous Question',action:'back'},
 {key:'ArrowRight',label:'→',description:'Next Question',action:'next'},
 ...Array.from({length:4},(_,index)=>({key:String(index+1),label:String(index+1),description:`Select ${'ABCD'[index]}`,action:'select',index})),
 ...Array.from({length:4},(_,index)=>({key:String(index+5),label:String(index+5),description:`Cross / Uncross ${'ABCD'[index]}`,action:'cross',index})),
 {key:'m',label:'M',description:'Mark / Undo Mark for Review',action:'mark'},
 {key:'Escape',label:'Esc',description:'Close dialogs / menu',action:'close'}
]);
