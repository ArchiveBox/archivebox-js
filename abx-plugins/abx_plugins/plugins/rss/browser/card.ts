import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/parse_rss_urls/full.html?raw';
import {feedURLs} from './feed';
export default async function(context:ViewContext){
 const {archive}=context;
 const feeds=[...await feedURLs(context)].map(url=>archive.find(url)).filter(entry=>!!entry);const rows:[string,unknown][]=[['Feeds',feeds.length],...feeds.slice(0,5).map(entry=>[entry.mime,entry.url] as [string,string])];
 return summaryCard(template,"Feeds",rows);
}
