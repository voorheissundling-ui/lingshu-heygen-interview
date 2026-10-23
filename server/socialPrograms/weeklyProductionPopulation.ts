import type {SocialWeeklyPublicationTask} from '../../shared/contracts/socialProgram.js';
/** Production quotas describe new work. Inventory keeps its separate frozen producer identity. */
export function weeklyProductionPopulation(publications:SocialWeeklyPublicationTask[]){
 const productionPublications=publications.filter(p=>!p.inventoryReuseRef);
 const inventoryPublications=publications.filter(p=>Boolean(p.inventoryReuseRef));
 const motherContentIds=[...new Set(productionPublications.map(p=>p.motherContentId))];
 return {productionPublications,inventoryPublications,motherContentIds,newMotherContentTarget:motherContentIds.length,newAdaptationVersionTarget:productionPublications.length-motherContentIds.length,inventoryPublicationTarget:inventoryPublications.length,totalPublicationTarget:publications.length};
}
