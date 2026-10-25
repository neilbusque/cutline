# Openverse photos and audio

Open **Stock**, select **Openverse**, then choose **Photos** or **Audio**. No account or API key is needed. Openverse does not supply video search; use Wikimedia or Pexels for B-roll.

Search for the visible subject or an audible event, such as `paper turn`, `mouse click`, or `soft impact`. Preview a sound before importing. **Library** downloads it without changing the timeline. **Add audio** places the sound at the playhead on an audible **Sound effects** track, with a starting volume of 50% and short edge fades. Adjust level, trim and placement in Properties after listening alongside the voice. It does not automatically sync sound to motion or normalize loudness.

Openverse results are requested with `license_type=commercial,modification`, then checked again for CC0, Public Domain Mark, CC BY or CC BY-SA. This excludes noncommercial and no-derivatives licenses. Attribution and share-alike requirements can still apply. Check the original source and license for the chosen use; an index is not a guarantee of rights or model/property releases.

Each imported asset retains its source, creator, title and license in the project, and a `.credits.txt` file beside its local media includes the provider's attribution text. **Export credits** lists the project's media credits. Keep those credits with your delivered video and credit the creator as its license requires.

This integration uses Openverse's public API and a bounded set of source hosts: Flickr and Wikimedia for photos, Freesound for audio. Other result hosts are omitted. Every media redirect is validated, downloads are limited to 200 MB, files are inspected on import, and unsupported or interrupted downloads are removed. The sound supplied by Freesound may be its openly accessible MP3 preview rather than the original WAV; review its quality before delivery.

Assistants can use `cutline_stock_search {provider:"openverse", kind:"audio", query:"paper turn"}` and import a returned UUID with `cutline_stock_import`. Include the current session, project and revision when importing, and `at` to place it. Audio imports are audible; visual B-roll imports stay muted. Do not add a whoosh to every cut: choose an accent for a meaningful action, then preserve quiet space.

Sources: [Openverse API](https://api.openverse.org/v1/), [API consumer documentation](https://docs.openverse.org/api/).
