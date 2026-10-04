# Local capture data

ArchiveBox JS captures websites into local WACZ files. It does not upload captures to ArchiveBox or any other service.

Capturing reloads or navigates the chosen tab. Enabled behaviors can scroll, expand details, dismiss known modals, or reject known cookie banners. Supplemental hooks may fetch page requisites, icons, social images, robots.txt, manifests and feeds using available browser credentials. Optional gallery, paper, forum and media hooks also request bounded original images/PDFs/media or public site API responses (including the Hacker News Firebase API). These requests are preserved in the same WACZ; archives are not submitted to those sites.

Captures can contain authenticated response bodies, HTTP metadata, browser logs, TLS details, screenshots, downloaded documents, and extracted text. Treat exported archives as copies of the pages you could see, including private content. DOM and accessibility views are derived from replay; secrets in original responses or visible screenshots can still be archived.

Responses are staged in extension-local IndexedDB and exported to extension-local OPFS. Completed captures remove their staging database after verification. Interrupted captures retain it for recovery. Delete a capture in the studio to remove its local archive and recovery database. Downloaded files remain wherever you saved them.

Extension HTML viewers disable archived scripts. The separate HTTP player supports interactive JavaScript replay through Webrecorder's service worker; plugin viewers read captured resources without contacting the original site. Import and derivation happen locally. Uninstalling the extension removes browser-managed local storage; export any captures you want to keep first.
