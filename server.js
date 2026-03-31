const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 配置
// ============================================================
const CONFIG = {
    APP_ID: process.env.FEISHU_APP_ID || 'cli_a941923f1a611ceb',
    APP_SECRET: process.env.FEISHU_APP_SECRET || 'pu4EkjA8mEDKiuoQyBnHLwk8wYYzKUXs',
    BITABLE_IMAGES_TOKEN: process.env.BITABLE_IMAGES_TOKEN || 'OayGbTb4DaqzSFsk7zgclqrXnjh',
    TABLE_IMAGES: process.env.TABLE_IMAGES || 'tblBmT3H1GkeUVkO',
    BITABLE_RECORDS_TOKEN: process.env.BITABLE_RECORDS_TOKEN || 'DP7sbUbGSajRfdsHO3gcK5C5nxd',
    TABLE_RECORDS: process.env.TABLE_RECORDS || 'tbl5nVzgHaHtu88S',
    ADMIN_PASSWORD_HASH: crypto.createHash('sha256').update('a3481616244.').digest('hex'),
};

// ============================================================
// Token 缓存
// ============================================================
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
        return tokenCache.token;
    }
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: CONFIG.APP_ID,
        app_secret: CONFIG.APP_SECRET
    });
    tokenCache.token = res.data.tenant_access_token;
    tokenCache.expiresAt = Date.now() + res.data.expire * 1000;
    return tokenCache.token;
}

// ============================================================
// 管理员验证
// ============================================================
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    const hash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (hash === CONFIG.ADMIN_PASSWORD_HASH) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: '密码错误' });
    }
});

// ============================================================
// 图片列表
// ============================================================
app.get('/api/images', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const images = allItems.map(item => {
            const f = item.fields;
            // 处理图片附件字段
            let imageUrl = '';
            if (f['图片'] && Array.isArray(f['图片']) && f['图片'].length > 0) {
                imageUrl = f['图片'][0].url || f['图片'][0].tmp_url || '';
            } else if (f['图片URL']) {
                imageUrl = f['图片URL'];
            }
            return {
                id: item.record_id,
                name: f['图片名称'] || '',
                url: imageUrl,
                color: f['颜色分类'] || '',
                theme: f['主题分类'] || '',
                downloads: parseInt(f['下载量'] || 0),
                countries: f['已下载国家'] ? f['已下载国家'].split(',').filter(Boolean) : []
            };
        });

        res.json({ success: true, data: images });
    } catch (err) {
        console.error('获取图片失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 下载记录列表
// ============================================================
app.get('/api/records', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const records = allItems.map(item => {
            const f = item.fields;
            return {
                id: item.record_id,
                imageName: f['图片名称'] || '',
                name: f['下载人'] || '',
                date: f['上线时间'] || '',
                country: f['所属国家'] || '',
                downloadTime: f['下载时间'] || ''
            };
        }).reverse();

        res.json({ success: true, data: records });
    } catch (err) {
        console.error('获取记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 提交下载记录
// ============================================================
app.post('/api/download', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { imageId, imageName, name, date, country } = req.body;

        if (!name || !date || !country || !imageId) {
            return res.status(400).json({ success: false, error: '缺少必填字段' });
        }

        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        // 写入下载记录
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '下载人': name,
                    '上线时间': date,
                    '所属国家': country,
                    '下载时间': now
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        // 更新图片下载量和国家
        const imgRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const fields = imgRes.data.data.record.fields;
        const currentDownloads = parseInt(fields['下载量'] || 0);
        const currentCountries = fields['已下载国家'] ? fields['已下载国家'].split(',').filter(Boolean) : [];
        if (!currentCountries.includes(country)) currentCountries.push(country);

        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
            {
                fields: {
                    '下载量': currentDownloads + 1,
                    '已下载国家': currentCountries.join(',')
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('下载记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 上传图片
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const token = await getTenantToken();
        const file = req.file;
        const imageName = req.body.name || file.originalname.replace(/\.[^/.]+$/, '');
        const color = req.body.color || '红色';
        const theme = req.body.theme || '促销';

        if (!file) return res.status(400).json({ success: false, error: '没有文件' });

        // 上传到飞书云文档
        const formData = new FormData();
        formData.append('file_name', file.originalname);
        formData.append('parent_type', 'bitable_file');
        formData.append('parent_node', CONFIG.BITABLE_IMAGES_TOKEN);
        formData.append('size', file.size.toString());
        formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
        });

        const uploadRes = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            formData,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...formData.getHeaders()
                }
            }
        );

        const fileToken = uploadRes.data.data.file_token;

        // 写入多维表格（用附件字段存图片）
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '图片': [{ file_token: fileToken }],
                    '颜色分类': color,
                    '主题分类': theme,
                    '下载量': 0,
                    '已下载国家': ''
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('上传失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 更新图片分类
// ============================================================
app.put('/api/images/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        const { name, color, theme } = req.body;

        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { fields: { '图片名称': name, '颜色分类': color, '主题分类': theme } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('更新失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 健康检查
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ 飞书图片资源中心已启动: http://localhost:${PORT}`);
});
