"""Reference for spec 10: storage/area at the pipe invert, sandbag crest and rim spill with the
surveyed water surface 1336.45 as today's level (seed cells' ground = the water surface)."""
import json, numpy as np, waterref as W
m,z,X,Y=W.load_window('fix_herman_window'); cell=m['cell']
ring=np.array(json.load(open('herman.json'))['geometry']['coordinates'][0])
o=W.overtop(z,X,Y,cell,ring)
zw=1336.45
seed=o['seed']; fl=o['flooded']; lv=np.where(seed, zw, np.nan)
# level grid: recompute from W.overtop? it returns 'flooded' and seed only; rebuild level by re-running the sealed flood is heavy.
# Instead use the stage table definition: cells with level<=L. We need level[]; patch: W.overtop stores it? no -> quick re-derivation:
level=o['level']
zeff=np.where(seed, zw, z)
out={}
for name,L in (('pipe',1341.55),('crest',1343.54),('spill',o['primary']['level'])):
    mk=fl&(level<=L+1e-9)
    st=np.clip(np.nan_to_num(L-zeff),0,None)*mk
    out[name]=dict(level=L,area_ac=float(mk.sum()*cell*cell/43560),storage_acft=float(st.sum()*cell*cell/43560),storage_ft3=float(st.sum()*cell*cell))
    print('%-6s L=%.2f  area %.2f ac  storage %.2f ac-ft (%.0f ft3)'%(name,L,out[name]['area_ac'],out[name]['storage_acft'],out[name]['storage_ft3']))
print('freeboard to spill from surveyed water: %.2f ft'%(o['primary']['level']-zw))
json.dump(out,open('survey_stage_ref.json','w'),indent=1)
