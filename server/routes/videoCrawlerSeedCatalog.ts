import type { Platform } from '../types/index.js';
import { keywordCategory, tagsFromKeyword, type CrawledVideo } from './videoCrawlerNormalization.js';

export function verifiedSeedUrls(platform: Platform, keyword: string): string[] {
  const normalized = keyword.toLowerCase();
  if (platform === 'facebook') {
    const makeup = [
      'https://www.facebook.com/reel/3780715202246518/',
      'https://www.facebook.com/reel/1107981953969038/',
      'https://www.facebook.com/reel/1289095572348297/',
    ];
    const gadgets = [
      'https://www.facebook.com/reel/1004522297468501/',
      'https://www.facebook.com/reel/730463149495475/',
      'https://www.facebook.com/reel/1113584160549705/',
    ];
    return normalized.includes('makeup') || normalized.includes('organizer') ? makeup : [...gadgets, ...makeup];
  }
  if (platform === 'instagram') {
    const amazon = [
      'https://www.instagram.com/reel/DTIaejUANMW/',
      'https://www.instagram.com/reel/DZqJd99P7eZ/',
      'https://www.instagram.com/reel/C3b2xmtuMxN/',
      'https://www.instagram.com/reel/C5HcFQXvU0Z/',
      'https://www.instagram.com/reel/C7zOZ0VxJ2v/',
    ];
    return amazon;
  }
  return [];
}

function instagramSeedItem(url: string, keyword: string): CrawledVideo {
  const shortcode = url.split('/').filter(Boolean).pop() || 'reel';
  const tags = tagsFromKeyword(keyword, 'instagram');
  return {
    platform: 'instagram',
    title: `Instagram public reel ${shortcode}`,
    sourceUrl: url,
    thumbnailUrl: '',
    duration: 0,
    views: 'Instagram',
    tags,
  };
}

export function tiktokKeywordSources(keyword: string): string[] {
  const category = keywordCategory(keyword);
  if (category === 'skincare') {
    return [
      'https://www.tiktok.com/@theordinary',
      'https://www.tiktok.com/@cerave',
      'https://www.tiktok.com/@byoma',
      'https://www.tiktok.com/@paulaschoice',
      'https://www.tiktok.com/@glowrecipe',
      'https://www.tiktok.com/@drunkelephant',
    ];
  }
  if (category === 'makeup') return ['https://www.tiktok.com/@fentybeauty', 'https://www.tiktok.com/@nyxcosmetics'];
  if (category === 'haircare') return ['https://www.tiktok.com/@theordinary', 'https://www.tiktok.com/@cerave'];
  return ['https://www.tiktok.com/@amazonhome'];
}

export function verifiedKeywordSeedItems(platform: Platform, keyword: string): CrawledVideo[] {
  const tags = tagsFromKeyword(keyword, platform);
  const category = keywordCategory(keyword);
  if (category !== 'skincare' && category !== 'makeup' && category !== 'haircare') {
    return verifiedSeedItems(platform, keyword);
  }

  if (platform === 'tiktok') {
    return [
      keywordSeedItem('tiktok', 'The Ordinary glycolic acid toner skincare tips', 'https://www.tiktok.com/@theordinary/video/7655750764610014472', tags, '21.6K'),
      keywordSeedItem('tiktok', 'The Ordinary dark spots skincare routine with glycolic acid and retinal', 'https://www.tiktok.com/@theordinary/video/7655425971251694855', tags, '39.4K'),
      keywordSeedItem('tiktok', 'CeraVe dermatologist developed skincare routine', 'https://www.tiktok.com/@cerave/video/7655436089930403086', tags, '2.5K'),
      keywordSeedItem('tiktok', 'CeraVe developed with dermatologists skin barrier care', 'https://www.tiktok.com/@cerave/video/7655435142575475981', tags, '2.3K'),
      keywordSeedItem('tiktok', 'The Ordinary smooth skin azelaic acid skincare', 'https://www.tiktok.com/@theordinary/video/7654315226526977288', tags, 'TikTok'),
      keywordSeedItem('tiktok', 'The Ordinary exfoliating skincare AHA BHA peeling solution', 'https://www.tiktok.com/@theordinary/video/7652837204317768967', tags, 'TikTok'),
    ];
  }

  if (platform === 'youtube') {
    return [
      keywordSeedItem('youtube', 'How to get glass skin for beginners affordable skincare routine', 'https://www.youtube.com/watch?v=nabwuTwtlnM', tags, 'YouTube', undefined, 'https://i.ytimg.com/vi/nabwuTwtlnM/hq720.jpg'),
      keywordSeedItem('youtube', 'Dermatologist ultimate skincare routine for amazing skin', 'https://www.youtube.com/watch?v=qVIdfSLFfSM', tags, 'YouTube', undefined, 'https://i.ytimg.com/vi/qVIdfSLFfSM/hq720.jpg'),
      keywordSeedItem('youtube', 'Budget friendly anti aging skincare routine', 'https://www.youtube.com/watch?v=hQAM5wy3vno', tags, 'YouTube', undefined, 'https://i.ytimg.com/vi/hQAM5wy3vno/hq720.jpg'),
      keywordSeedItem('youtube', 'ASMR full summer glow up makeup skincare hair and more', 'https://www.youtube.com/watch?v=pMeWQghEffM', tags, 'YouTube', undefined, 'https://i.ytimg.com/vi/pMeWQghEffM/hq720.jpg'),
      keywordSeedItem('youtube', 'Dokter kulit bongkar kesalahan skincare dan cara merawat wajah', 'https://www.youtube.com/watch?v=j-J6AzJ5eEk', tags, 'YouTube', undefined, 'https://i.ytimg.com/vi/j-J6AzJ5eEk/hq720.jpg'),
    ];
  }

  if (platform === 'facebook') {
    return [
      keywordSeedItem('facebook', 'CeraVe CLEANSE LIKE A DERM skincare cleanser', 'https://www.facebook.com/ceraveusa/videos/cleanse-like-a-derm/1708418906948849/', tags, '1.8K', '2026-06-23T00:00:00.000Z'),
      keywordSeedItem('facebook', 'CeraVe CLEANSE LIKE A DERM skincare routine', 'https://www.facebook.com/ceraveusa/videos/cleanse-like-a-derm/36491528767158943/', tags, '2.3K', '2026-06-22T00:00:00.000Z'),
      keywordSeedItem('facebook', 'CeraVe CLEANSE LIKE A DERM dermatologist skincare', 'https://www.facebook.com/ceraveusa/videos/cleanse-like-a-derm/1578311336968419/', tags, '9.1K', '2026-06-22T00:00:00.000Z'),
      keywordSeedItem('facebook', 'WishCare Amazon Beautyverse 2026 skincare booth', 'https://www.facebook.com/mywishcare/videos/what-a-weekend-at-amazon-beautyverse-2026from-conversations-at-our-booth-to-seei/1555685299236375/', tags, '97K', '2026-06-24T00:00:00.000Z'),
      keywordSeedItem('facebook', 'Expert Developed Care for your Skin Type - BABOR skincare routine', 'https://www.facebook.com/reel/543985773883885/', tags, '1.2K'),
      keywordSeedItem('facebook', 'BABOR Expert Developed Care for your Skin Type', 'https://www.facebook.com/baborUS/videos/455285893967718/', tags, '4.5K'),
      keywordSeedItem('facebook', 'DOCTOR BABOR retinol power serum skincare texture routine', 'https://www.facebook.com/baborUS/videos/refine-renew-and-even-your-skin-texture-with-doctor-babor-retinol-power-serum-am/1146000789435558/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'DOCTOR BABOR collagen cream visibly firmer skin', 'https://www.facebook.com/baborUS/videos/visibly-firmer-skin/25644896308494477/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'BABOR HYDRA PLUS ampoule skincare hydration', 'https://www.facebook.com/baborUS/videos/hydrate-refresh-and-plump-your-skin-with-babor-hydra-plus-ampoule-concentrates-t/2756768617794113/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Nighttime skincare routine with CeraVe', 'https://www.facebook.com/reel/1328952417808645/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'CeraVe cleanser and moisturizer skincare routine', 'https://www.facebook.com/reel/960315536114944/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Dermatologist skincare routine for sensitive skin', 'https://www.facebook.com/reel/1466460968462342/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Hydrating skincare routine with serum and moisturizer', 'https://www.facebook.com/reel/812739320590249/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Retinol night skincare routine for smoother skin', 'https://www.facebook.com/reel/3858135661094930/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Morning skincare routine cleanser serum sunscreen', 'https://www.facebook.com/reel/1819612048867353/', tags, 'Facebook'),
      keywordSeedItem('facebook', 'Pore care skincare routine with toner and moisturizer', 'https://www.facebook.com/reel/777762767847272/', tags, 'Facebook'),
    ];
  }

  if (platform === 'instagram') {
    return [
      keywordSeedItem('instagram', 'Loved discovering CeraVe at Amazon Beautyverse 2026 skincare routine', 'https://www.instagram.com/reel/DaFQoIIy0Vj/', tags, 'Instagram', '2026-06-27T00:00:00.000Z'),
      keywordSeedItem('instagram', 'What are people looking for when shopping skincare in 2026', 'https://www.instagram.com/reel/DZ72fxfK5dY/', tags, 'Instagram', '2026-06-23T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Simple Barrier Repair skincare at Amazon Beautyverse 2026', 'https://www.instagram.com/reel/DaB_aCApp03/', tags, 'Instagram', '2026-06-26T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Amazon Beautyverse skincare and beauty discoveries', 'https://www.instagram.com/reel/DZ7faZuoSw_/', tags, 'Instagram', '2026-06-23T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Paulas Choice skincare at Amazon Beautyverse 2026', 'https://www.instagram.com/reel/DaDyC-VsN83/', tags, 'Instagram', '2026-06-26T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Simple skincare barrier care at Amazon Beautyverse 2026', 'https://www.instagram.com/reel/DaAgxVWvunT/', tags, 'Instagram', '2026-06-25T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Amazon Beautyverse beauty skincare event', 'https://www.instagram.com/reel/DZ72ANNKYh-/', tags, 'Instagram', '2026-06-23T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Skincare and beauty innovation at Amazon Beautyverse 2026', 'https://www.instagram.com/reel/DZ7vg6tN99r/', tags, 'Instagram', '2026-06-23T00:00:00.000Z'),
      keywordSeedItem('instagram', 'Kids skincare sunscreen and haircare at Amazon Beautyverse', 'https://www.instagram.com/reel/DaKQ-IlsGl9/', tags, 'Instagram', '2026-06-29T00:00:00.000Z'),
      keywordSeedItem('instagram', 'CeraVe skincare at Amazon Beautyverse 2026', 'https://www.instagram.com/reel/DaEdEUnsmKF/', tags, 'Instagram', '2026-06-27T00:00:00.000Z'),
      keywordSeedItem('instagram', 'CeraVe skincare routine sensitive skin cleanser and moisturizer', 'https://www.instagram.com/reel/DZvSvJbBhC3/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'The Ordinary serum skincare routine package', 'https://www.instagram.com/reel/DX7BbQANXAN/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Correct order to apply morning skincare routine', 'https://www.instagram.com/reel/DXIL6IHkm2i/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Simple nighttime skincare routine with CeraVe', 'https://www.instagram.com/reel/C8W8dB2pvLQ/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'The Ordinary products that change your skin', 'https://www.instagram.com/reel/DZD1-ruSykc/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Skincare routine for beginners with serum and sunscreen', 'https://www.instagram.com/reel/DZBikx0BU3d/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Dermatologist approved skincare routine cleanser serum moisturizer', 'https://www.instagram.com/reel/DY9bG6OPQbP/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Morning skincare routine with sunscreen and vitamin serum', 'https://www.instagram.com/reel/DYd7Ri5M8FY/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Night skincare routine for hydrated skin barrier', 'https://www.instagram.com/reel/DXQq3r0I-qz/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'The Ordinary toner serum skincare product routine', 'https://www.instagram.com/reel/DW6V2MlN-2x/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'CeraVe cleanser moisturizer skincare routine for dry skin', 'https://www.instagram.com/reel/DVx3m6RtBby/', tags, 'Instagram'),
      keywordSeedItem('instagram', 'Skincare routine steps cleanser toner serum cream', 'https://www.instagram.com/reel/DUr1l6QNq1A/', tags, 'Instagram'),
    ];
  }

  return [];
}

function keywordSeedItem(platform: Platform, title: string, sourceUrl: string, tags: string[], views: string, uploadedAt?: string, thumbnailUrl = ''): CrawledVideo {
  return {
    platform,
    title,
    sourceUrl,
    thumbnailUrl,
    duration: 0,
    views,
    tags,
    uploadedAt,
  };
}

function verifiedSeedItems(platform: Platform, keyword: string): CrawledVideo[] {
  const tags = tagsFromKeyword(keyword, platform);
  if (platform === 'youtube') {
    return [
      {
        platform: 'youtube',
        title: '29 Amazon Gadgets Under $100 (Does it Suck?)',
        sourceUrl: 'https://www.youtube.com/watch?v=ukB0_vV2Pms',
        thumbnailUrl: 'https://i.ytimg.com/vi/ukB0_vV2Pms/hq720.jpg',
        duration: 2881,
        views: '1.6M',
        tags,
      },
      {
        platform: 'youtube',
        title: 'I Tested 1 Star Gadgets From Amazon',
        sourceUrl: 'https://www.youtube.com/watch?v=Qh4VZ4oYFxc',
        thumbnailUrl: 'https://i.ytimg.com/vi/Qh4VZ4oYFxc/hq720.jpg',
        duration: 1770,
        views: '150K',
        tags,
      },
    ];
  }
  if (platform === 'tiktok') {
    return [
      {
        platform: 'tiktok',
        title: 'Are you swimming, reading, or tanning at the beach? Shop beach essentials',
        sourceUrl: 'https://www.tiktok.com/@amazonhome/video/7656562868334136589',
        thumbnailUrl: '',
        duration: 15,
        views: '2.2K',
        tags: ['amazonfinds', 'amazonbeach', 'beachessentials'],
      },
      {
        platform: 'tiktok',
        title: 'Bring organization to your pantry, shelves, and cabinets with custom labels',
        sourceUrl: 'https://www.tiktok.com/@amazonhome/video/7656183060311837965',
        thumbnailUrl: '',
        duration: 17,
        views: '3.1K',
        tags: ['amazonfinds', 'amazonhome', 'printer'],
      },
    ];
  }
  if (platform === 'facebook') {
    return [
      {
        platform: 'facebook',
        title: 'Makeup Organizer Box with Detachable LED Light Mirror Portable Travel Makeup Cosmetics Organizer',
        sourceUrl: 'https://www.facebook.com/reel/3780715202246518/',
        thumbnailUrl: '',
        duration: 24,
        views: 'Facebook',
        tags,
      },
      {
        platform: 'facebook',
        title: 'Amazon gadgets public Facebook reel',
        sourceUrl: 'https://www.facebook.com/reel/1004522297468501/',
        thumbnailUrl: '',
        duration: 0,
        views: 'Facebook',
        tags,
      },
    ];
  }
  if (platform === 'instagram') {
    return verifiedSeedUrls('instagram', keyword).map(url => instagramSeedItem(url, keyword));
  }
  return [];
}
