import type{DataStore}from'../storage/datastore.js';
import{socialObject,socialJson}from'../starter198/socialContentValidation.js';
import{verifyFrozenWeeklyCustomerRelationship,type WeeklyCustomerRelationshipScope}from'./weeklyCustomerRelationshipScope.js';
import{verifyWeeklyNativeMember,verifyWeeklyWhatsAppMember}from'./weeklyCustomerChannelSelections.js';
/** Fresh proof at draft/read/send boundaries, preserving genuine legacy WA evidence. */
export async function verifyWeeklyCustomerMemberProof(store:DataStore,scope:WeeklyCustomerRelationshipScope,customerId:string,snapshot:unknown){const object=socialObject(socialJson(snapshot));const selection=socialObject(object?.weeklyChannelSelection);if(selection){if(selection.channel==='whatsapp')return verifyWeeklyWhatsAppMember(store,scope,customerId,object);return verifyWeeklyNativeMember(store,scope,customerId,object);}return verifyFrozenWeeklyCustomerRelationship(store,scope,customerId,snapshot);}
