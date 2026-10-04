import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/sslcerts/full.html?raw';
export default async function(context:ViewContext){
 const {archive}=context;
 const entry=archive.artifact('sslcerts'),data=entry?await archive.json(entry):{};
 const connection=data.connections?.[0],tls=connection?.securityDetails||{};
 const rows:[string,unknown][]=[['Subject',tls.subjectName],['Issuer',tls.issuer],['Protocol',tls.protocol],['Cipher',tls.cipher],['Connections',data.connections?.length]];
 return summaryCard(template,"SSL Certificates",rows);
}
