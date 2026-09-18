# Product requirements

Status: planned

The application is named 手不释卷 in Chinese and GripRead in English.

## Goal

GripRead is a lightweight reader for people who read novels on both a phone and a desktop. Its primary outcome is immediate local reading and a reliable return to the same passage across devices. The default product language is Chinese; maintained engineering documentation is English.

## Release scope

The initial platform targets are Android, Windows, and macOS. Local reading requires neither an account nor a cloud connection. Optional WebDAV adds personal cloud storage without an application account service.

| Capability | User outcome | Specification |
| --- | --- | --- |
| Local novels | Import and read TXT and DRM-free reflowable EPUB offline | [Reader](../subsystems/reader.md), [Library](../subsystems/library.md) |
| Online novels | Use Legado text sources to find, follow, cache, and read books | [Sources](../subsystems/sources.md) |
| Independent RSS reader | Read RSS/Atom feeds, exchange OPML subscriptions, and manage unread/favorite articles | [RSS](../subsystems/rss.md) |
| Cross-device reading | Share shelf records and reading state, browse a cloud book folder, and recover backups | [Sync](../subsystems/sync.md) |
| Later AI assistance | Review character events and plot summaries bounded by reading progress | [AIGC](../subsystems/aigc.md) |

## Priorities and boundaries

Local reading is completed before source compatibility implementation begins. AI assistance follows stable reading and data capabilities and is not a prerequisite for the initial reading experience. The [roadmap](../plans/roadmap.md) owns stage dependencies; it is not a schedule or permission to advance stages.

Novel sources and standard RSS are separate features. Legado `rssSource` webpage rules, comics, audio books, text-to-speech, account services, iOS, and Linux are outside the initial scope.

Books and reading state remain usable during network and optional-service failures. Display compatibility limits and incomplete operations honestly. The [interaction specification](../design/interaction.md) owns presentation, while each subsystem owns observable behavior and acceptance scenarios.
